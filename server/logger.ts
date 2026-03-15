import fs from 'fs';
import path from 'path';
import * as winston from 'winston';
import 'winston-daily-rotate-file';

const hformat = winston.format.printf(
  ({ level, label, message, timestamp, ...metadata }) => {
    let msg = `${timestamp} [${level}]${
      label ? `[${label}]` : ''
    }: ${message} `;
    if (Object.keys(metadata).length > 0) {
      msg += JSON.stringify(metadata);
    }
    return msg;
  }
);

// Ensure the logs directory exists before winston tries to create it.
// On CIFS/SMB mounts, mkdirSync on an already-existing path can fail with
// EACCES, so we guard with existsSync first.
const logsDir = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/logs`
  : path.join(__dirname, '../config/logs');

if (!fs.existsSync(logsDir)) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch {
    // If we can't create it, winston will fall back to console-only logging
  }
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL?.toLowerCase() || 'debug',
  format: winston.format.combine(
    winston.format.splat(),
    winston.format.timestamp(),
    hformat
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.splat(),
        winston.format.timestamp(),
        hformat
      ),
    }),
    new winston.transports.DailyRotateFile({
      filename: process.env.CONFIG_DIRECTORY
        ? `${process.env.CONFIG_DIRECTORY}/logs/seerr-%DATE%.log`
        : path.join(__dirname, '../config/logs/seerr-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '7d',
      createSymlink: false,
    }),
    new winston.transports.DailyRotateFile({
      filename: process.env.CONFIG_DIRECTORY
        ? `${process.env.CONFIG_DIRECTORY}/logs/.machinelogs-%DATE%.json`
        : path.join(__dirname, '../config/logs/.machinelogs-%DATE%.json'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '1d',
      createSymlink: false,
      format: winston.format.combine(
        winston.format.splat(),
        winston.format.timestamp(),
        winston.format.json()
      ),
    }),
  ],
});

export default logger;
