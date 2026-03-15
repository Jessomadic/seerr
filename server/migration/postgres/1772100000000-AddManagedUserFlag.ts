import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddManagedUserFlag1772100000000 implements MigrationInterface {
  name = 'AddManagedUserFlag1772100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "isManagedUser" boolean NOT NULL DEFAULT false`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN "isManagedUser"`
    );
  }
}
