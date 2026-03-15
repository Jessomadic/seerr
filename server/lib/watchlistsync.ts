import PlexTvAPI, { type PlexWatchlistItem } from '@server/api/plextv';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  BlocklistedMediaError,
  DuplicateMediaRequestError,
  MediaRequest,
  NoSeasonsAvailableError,
  QuotaRestrictedError,
  RequestPermissionError,
} from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import logger from '@server/logger';
import { Permission } from './permissions';

class WatchlistSync {
  public async syncWatchlist() {
    const userRepository = getRepository(User);

    // Phase 1: Regular users who have their own Plex token
    const users = await userRepository
      .createQueryBuilder('user')
      .addSelect('user.plexToken')
      .leftJoinAndSelect('user.settings', 'settings')
      .where("user.plexToken != ''")
      .getMany();

    for (const user of users) {
      await this.syncUserWatchlist(user);
    }

    // Phase 2: Managed users — obtain a temp token via admin's /switch endpoint
    const managedUsers = await userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.settings', 'settings')
      .where('user.isManagedUser = :isManaged', { isManaged: true })
      .getMany();

    if (managedUsers.length > 0) {
      const adminUser = await userRepository.findOne({
        select: { id: true, plexToken: true },
        where: { id: 1 },
      });

      if (!adminUser?.plexToken) {
        logger.warn(
          'Cannot sync managed user watchlists: admin user has no Plex token',
          { label: 'Watchlist Sync' }
        );
        return;
      }

      const adminPlexTv = new PlexTvAPI(adminUser.plexToken);

      for (const managedUser of managedUsers) {
        await this.syncManagedUserWatchlist(managedUser, adminPlexTv);
      }
    }
  }

  private async syncUserWatchlist(user: User) {
    if (!user.plexToken) {
      logger.warn('Skipping user watchlist sync for user without plex token', {
        label: 'Plex Watchlist Sync',
        user: user.displayName,
      });
      return;
    }

    if (
      !user.hasPermission(
        [
          Permission.AUTO_REQUEST,
          Permission.AUTO_REQUEST_MOVIE,
          Permission.AUTO_REQUEST_TV,
        ],
        { type: 'or' }
      )
    ) {
      return;
    }

    if (
      !user.settings?.watchlistSyncMovies &&
      !user.settings?.watchlistSyncTv
    ) {
      return;
    }

    const plexTvApi = new PlexTvAPI(user.plexToken);
    const response = await plexTvApi.getWatchlist({ size: 20 });

    await this.processWatchlistItems(user, response.items);
  }

  private async syncManagedUserWatchlist(user: User, adminPlexTv: PlexTvAPI) {
    const logCtx = {
      label: 'Watchlist Sync',
      userId: user.id,
      displayName: user.displayName,
      plexId: user.plexId,
    };

    if (!user.plexId) {
      logger.debug('Skipping managed user: no plexId stored', logCtx);
      return;
    }

    if (
      !user.hasPermission(
        [
          Permission.AUTO_REQUEST,
          Permission.AUTO_REQUEST_MOVIE,
          Permission.AUTO_REQUEST_TV,
        ],
        { type: 'or' }
      )
    ) {
      logger.debug(
        'Skipping managed user: missing AUTO_REQUEST permission — grant it in Settings → Users',
        logCtx
      );
      return;
    }

    if (
      !user.settings?.watchlistSyncMovies &&
      !user.settings?.watchlistSyncTv
    ) {
      logger.debug(
        'Skipping managed user: watchlist sync not enabled — turn on "Auto-Request Movies" or "Auto-Request Series" in the user profile settings',
        logCtx
      );
      return;
    }

    logger.debug('Attempting managed user watchlist sync', logCtx);

    const tempToken = await adminPlexTv.switchToManagedUser(user.plexId);

    if (!tempToken) {
      logger.warn(
        'Failed to obtain temp token for managed user — check the debug log above for the raw Plex response',
        logCtx
      );
      return;
    }

    logger.debug('Got temp token for managed user, fetching watchlist', logCtx);

    const managedPlexTv = new PlexTvAPI(tempToken);
    const response = await managedPlexTv.getWatchlist({ size: 20 });

    logger.debug('Managed user watchlist fetched', {
      ...logCtx,
      itemCount: response.items.length,
      totalSize: response.totalSize,
    });

    await this.processWatchlistItems(user, response.items);
  }

  private async processWatchlistItems(user: User, items: PlexWatchlistItem[]) {
    if (items.length === 0) {
      return;
    }

    const mediaItems = await Media.getRelatedMedia(
      user,
      items.map((i) => ({
        tmdbId: i.tmdbId,
        mediaType: i.type === 'show' ? MediaType.TV : MediaType.MOVIE,
      }))
    );

    const watchlistTmdbIds = items.map((i) => i.tmdbId);

    const requestRepository = getRepository(MediaRequest);
    const existingAutoRequests = await requestRepository
      .createQueryBuilder('request')
      .leftJoinAndSelect('request.media', 'media')
      .where('request.requestedBy = :userId', { userId: user.id })
      .andWhere('request.isAutoRequest = true')
      .andWhere('media.tmdbId IN (:...tmdbIds)', { tmdbIds: watchlistTmdbIds })
      .getMany();

    const autoRequestedTmdbIds = new Set(
      existingAutoRequests
        .filter((r) => r.media != null)
        .map((r) => `${r.media.mediaType}:${r.media.tmdbId}`)
    );

    const unavailableItems = items.filter((i) => {
      const itemMediaType = i.type === 'show' ? MediaType.TV : MediaType.MOVIE;

      return (
        !autoRequestedTmdbIds.has(`${itemMediaType}:${i.tmdbId}`) &&
        !mediaItems.find(
          (m) =>
            m.tmdbId === i.tmdbId &&
            m.mediaType === itemMediaType &&
            (m.status === MediaStatus.BLOCKLISTED ||
              (itemMediaType === MediaType.MOVIE &&
                m.status !== MediaStatus.UNKNOWN) ||
              (itemMediaType === MediaType.TV &&
                m.status === MediaStatus.AVAILABLE))
        )
      );
    });

    for (const mediaItem of unavailableItems) {
      try {
        logger.info("Creating media request from user's Plex Watchlist", {
          label: 'Watchlist Sync',
          userId: user.id,
          mediaTitle: mediaItem.title,
        });

        if (mediaItem.type === 'show' && !mediaItem.tvdbId) {
          throw new Error('Missing TVDB ID from Plex Metadata');
        }

        // Check if they have auto-request permissions and watchlist sync
        // enabled for the media type
        if (
          ((!user.hasPermission(
            [Permission.AUTO_REQUEST, Permission.AUTO_REQUEST_MOVIE],
            { type: 'or' }
          ) ||
            !user.settings?.watchlistSyncMovies) &&
            mediaItem.type === 'movie') ||
          ((!user.hasPermission(
            [Permission.AUTO_REQUEST, Permission.AUTO_REQUEST_TV],
            { type: 'or' }
          ) ||
            !user.settings?.watchlistSyncTv) &&
            mediaItem.type === 'show')
        ) {
          continue;
        }

        await MediaRequest.request(
          {
            mediaId: mediaItem.tmdbId,
            mediaType:
              mediaItem.type === 'show' ? MediaType.TV : MediaType.MOVIE,
            seasons: mediaItem.type === 'show' ? 'all' : undefined,
            tvdbId: mediaItem.tvdbId,
            is4k: false,
          },
          user,
          { isAutoRequest: true }
        );
      } catch (e) {
        if (!(e instanceof Error)) {
          continue;
        }

        switch (e.constructor) {
          // During watchlist sync, these errors aren't necessarily
          // a problem with Seerr. Since we are auto syncing these constantly, it's
          // possible they are unexpectedly at their quota limit, for example. So we'll
          // instead log these as debug messages.
          case RequestPermissionError:
          case DuplicateMediaRequestError:
          case QuotaRestrictedError:
          case NoSeasonsAvailableError:
            logger.debug('Failed to create media request from watchlist', {
              label: 'Watchlist Sync',
              userId: user.id,
              mediaTitle: mediaItem.title,
              errorMessage: e.message,
            });
            break;
          // Blocklisted media should be silently ignored during watchlist sync to avoid spam
          case BlocklistedMediaError:
            break;
          default:
            logger.error('Failed to create media request from watchlist', {
              label: 'Watchlist Sync',
              userId: user.id,
              mediaTitle: mediaItem.title,
              errorMessage: e.message,
            });
        }
      }
    }
  }
}

const watchlistSync = new WatchlistSync();

export default watchlistSync;
