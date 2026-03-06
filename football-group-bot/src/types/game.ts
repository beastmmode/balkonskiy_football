export interface Participant {
  userId: number;
  username?: string;
  firstName?: string;
  teamIndex: number;
  paid: boolean;
  paidAt?: string;
  tentative: boolean;
  tentativeAt?: string;
  joinedAt: string;
}

export interface Game {
  id: string;
  chatId: number;
  messageId: number;
  createdBy: number;
  createdAt: string;
  date: string;
  time: string;
  location: string;
  slots: number;
  price: string;
  requisites: string;
  teamNames: string[];
  participants: Participant[];
}

export interface Database {
  games: Game[];
}
