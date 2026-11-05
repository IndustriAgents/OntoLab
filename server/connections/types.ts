import type { GraphConnection } from "../../src/types/connections.ts";
/** Only repositories and server services can see encrypted credentials. */
export interface StoredConnection extends GraphConnection {
  encryptedAuth?: string;
}
export interface ConnectionRepo {
  list(): Promise<StoredConnection[]>;
  get(id: string): Promise<StoredConnection | null>;
  /** null creates; an integer updates only that version. */
  put(value: StoredConnection, expectedVersion: number | null): Promise<void>;
  delete(id: string, expectedVersion: number): Promise<void>;
}
