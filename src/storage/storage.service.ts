import { Injectable } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Database } from '../types/game';
import { env } from '../config/env';

@Injectable()
export class StorageService {
  private readonly dbPath = resolve(env.storagePath ?? resolve(process.cwd(), 'storage-data.json'));
  private writeQueue: Promise<void> = Promise.resolve();

  async readDb(): Promise<Database> {
    try {
      const raw = await readFile(this.dbPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<Database>;
      if (!Array.isArray(parsed.games)) {
        return { games: [] };
      }
      return { games: parsed.games };
    } catch {
      return { games: [] };
    }
  }

  async writeDb(nextDb: Database): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.dbPath), { recursive: true });
      await writeFile(this.dbPath, JSON.stringify(nextDb, null, 2), 'utf-8');
    });

    await this.writeQueue;
  }
}
