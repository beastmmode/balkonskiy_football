import { Module } from '@nestjs/common';
import { TelegrafModule } from 'nestjs-telegraf';
import { env } from '../config/env';
import { StorageModule } from '../storage/storage.module';
import { BotUpdate } from './bot.update';

@Module({
  imports: [
    StorageModule,
    TelegrafModule.forRoot({
      token: env.botToken,
    }),
  ],
  providers: [BotUpdate],
})
export class BotModule {}
