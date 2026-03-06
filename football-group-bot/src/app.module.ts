import { Module } from '@nestjs/common';
import { BotModule } from './bot/bot.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [StorageModule, BotModule],
})
export class AppModule {}
