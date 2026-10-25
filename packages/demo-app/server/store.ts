/**
 * The demo product's own data, in one SQLite file: its users and their credits, sign-in
 * cookies, the MCP tokens it mints for the engine, conversations (one engine session each),
 * turns (one engine message each, with what it cost) and the notes its MCP tools keep.
 *
 * Tokens are stored as SHA-256 hashes, never as issued.
 */

import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  credits: number;
  createdAt: number;
}

export interface Conversation {
  id: string;
  userId: string;
  engineSessionId: string;
  title: string;
  createdAt: number;
}

type TurnStatus = "running" | "settled";

export interface Turn {
  messageId: string;
  conversationId: string;
  userId: string;
  prompt: string;
  reply: string;
  status: TurnStatus;
  engineStatus: string | null;
  runtime: string | null;
  costUsd: number;
  credits: number;
  createdAt: number;
}

export interface Note {
  id: string;
  text: string;
  createdAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  credits INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  engine_session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  prompt TEXT NOT NULL,
  reply TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  engine_status TEXT,
  runtime TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  credits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newId(bytes = 8): string {
  return randomBytes(bytes).toString("hex");
}

type Row = Record<string, unknown>;

function toUser(row: Row): User {
  return {
    id: String(row.id),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    credits: Number(row.credits),
    createdAt: Number(row.created_at),
  };
}

function toConversation(row: Row): Conversation {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    engineSessionId: String(row.engine_session_id),
    title: String(row.title),
    createdAt: Number(row.created_at),
  };
}

function toTurn(row: Row): Turn {
  return {
    messageId: String(row.message_id),
    conversationId: String(row.conversation_id),
    userId: String(row.user_id),
    prompt: String(row.prompt),
    reply: String(row.reply),
    status: row.status === "settled" ? "settled" : "running",
    engineStatus: row.engine_status == null ? null : String(row.engine_status),
    runtime: row.runtime == null ? null : String(row.runtime),
    costUsd: Number(row.cost_usd),
    credits: Number(row.credits),
    createdAt: Number(row.created_at),
  };
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // --- users --------------------------------------------------------------

  createUser(email: string, passwordHash: string, credits: number): User {
    const user: User = { id: newId(), email, passwordHash, credits, createdAt: this.now() };
    this.db
      .prepare(
        "INSERT INTO users (id, email, password_hash, credits, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(user.id, user.email, user.passwordHash, user.credits, user.createdAt);
    return user;
  }

  userByEmail(email: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    return row ? toUser(row) : null;
  }

  userById(id: string): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return row ? toUser(row) : null;
  }

  // --- tokens -------------------------------------------------------------

  /** Issue a random token for a user in one of the token tables; only its hash is kept. */
  issueToken(table: "web_sessions" | "mcp_tokens", userId: string, ttlMs: number): string {
    const token = randomBytes(32).toString("hex");
    this.db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(this.now());
    this.db
      .prepare(`INSERT INTO ${table} (token_hash, user_id, expires_at) VALUES (?, ?, ?)`)
      .run(hashToken(token), userId, this.now() + ttlMs);
    return token;
  }

  userForToken(table: "web_sessions" | "mcp_tokens", token: string): User | null {
    const row = this.db
      .prepare(
        `SELECT users.* FROM ${table} JOIN users ON users.id = ${table}.user_id
         WHERE token_hash = ? AND expires_at > ?`
      )
      .get(hashToken(token), this.now());
    return row ? toUser(row) : null;
  }

  revokeToken(table: "web_sessions" | "mcp_tokens", token: string): void {
    this.db.prepare(`DELETE FROM ${table} WHERE token_hash = ?`).run(hashToken(token));
  }

  // --- conversations ------------------------------------------------------

  createConversation(userId: string, engineSessionId: string, title: string): Conversation {
    const conversation: Conversation = {
      id: newId(),
      userId,
      engineSessionId,
      title,
      createdAt: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO conversations (id, user_id, engine_session_id, title, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(conversation.id, userId, engineSessionId, title, conversation.createdAt);
    return conversation;
  }

  /** A conversation, only if it belongs to the user. */
  conversation(userId: string, id: string): Conversation | null {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE id = ? AND user_id = ?")
      .get(id, userId);
    return row ? toConversation(row) : null;
  }

  conversations(userId: string): Conversation[] {
    return this.db
      .prepare("SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId)
      .map(toConversation);
  }

  renameConversation(id: string, title: string): void {
    this.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, id);
  }

  // --- turns --------------------------------------------------------------

  createTurn(conversation: Conversation, messageId: string, prompt: string): Turn {
    this.db
      .prepare(
        `INSERT INTO turns (message_id, conversation_id, user_id, prompt, status, created_at)
         VALUES (?, ?, ?, ?, 'running', ?)`
      )
      .run(messageId, conversation.id, conversation.userId, prompt, this.now());
    return this.turn(messageId) as Turn;
  }

  turn(messageId: string): Turn | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE message_id = ?").get(messageId);
    return row ? toTurn(row) : null;
  }

  turns(conversationId: string): Turn[] {
    return this.db
      .prepare("SELECT * FROM turns WHERE conversation_id = ? ORDER BY created_at ASC")
      .all(conversationId)
      .map(toTurn);
  }

  /** Conversations of a user that still have a turn waiting to be settled. */
  conversationsWithRunningTurns(userId: string): Conversation[] {
    return this.db
      .prepare(
        `SELECT DISTINCT conversations.* FROM conversations
         JOIN turns ON turns.conversation_id = conversations.id
         WHERE conversations.user_id = ? AND turns.status = 'running'`
      )
      .all(userId)
      .map(toConversation);
  }

  saveReply(messageId: string, reply: string): void {
    this.db.prepare("UPDATE turns SET reply = ? WHERE message_id = ?").run(reply, messageId);
  }

  /**
   * Settle a running turn once: record its cost and take the credits from its user, in one
   * transaction. Returns false if the turn was already settled (or does not exist).
   */
  settleTurn(
    messageId: string,
    settlement: { engineStatus: string; runtime: string | null; costUsd: number; credits: number }
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const turn = this.turn(messageId);
      if (!turn || turn.status === "settled") {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare(
          `UPDATE turns SET status = 'settled', engine_status = ?, runtime = ?, cost_usd = ?,
           credits = ? WHERE message_id = ?`
        )
        .run(
          settlement.engineStatus,
          settlement.runtime,
          settlement.costUsd,
          settlement.credits,
          messageId
        );
      this.db
        .prepare("UPDATE users SET credits = credits - ? WHERE id = ?")
        .run(settlement.credits, turn.userId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Take `credits` from a user for something a tool made, only if they have that many: the new
   * balance, or null (and nothing taken) when they cannot afford it.
   */
  spendCredits(userId: string, credits: number): number | null {
    const row = this.db
      .prepare(
        "UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ? RETURNING credits"
      )
      .get(credits, userId, credits);
    return row ? Number(row.credits) : null;
  }

  // --- notes (the data behind the product's MCP tools) -------------------

  addNote(userId: string, text: string): Note {
    const note: Note = { id: newId(4), text, createdAt: this.now() };
    this.db
      .prepare("INSERT INTO notes (id, user_id, text, created_at) VALUES (?, ?, ?, ?)")
      .run(note.id, userId, text, note.createdAt);
    return note;
  }

  notes(userId: string): Note[] {
    return this.db
      .prepare("SELECT id, text, created_at FROM notes WHERE user_id = ? ORDER BY created_at ASC")
      .all(userId)
      .map((row) => ({
        id: String(row.id),
        text: String(row.text),
        createdAt: Number(row.created_at),
      }));
  }
}
