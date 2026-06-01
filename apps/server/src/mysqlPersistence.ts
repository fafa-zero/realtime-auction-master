import type {
  Auction,
  AuctionHistoryItem,
  Bid,
  DanmakuBlockedUser,
  DanmakuMessage,
  LiveRoom,
  Order,
  Product,
  Session,
  User
} from "./types.js";

export interface PersistedAuctionState {
  liveRooms: LiveRoom[];
  users: User[];
  sessions: Session[];
  products: Product[];
  auctions: Auction[];
  bids: Bid[];
  orders: Order[];
  history: AuctionHistoryItem[];
  danmakuMessages: DanmakuMessage[];
  danmakuBlockedUsers: DanmakuBlockedUser[];
}

type MysqlPool = {
  query: (sql: string, values?: unknown[]) => Promise<unknown[]>;
  getConnection: () => Promise<MysqlConnection>;
};

type MysqlConnection = {
  beginTransaction: () => Promise<void>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
  query: (sql: string, values?: unknown[]) => Promise<unknown[]>;
  release: () => void;
};

type MysqlModule = {
  createPool: (config: string | Record<string, unknown>) => MysqlPool;
};

const MYSQL_TABLES = {
  liveRooms: "auction_live_rooms",
  users: "auction_users",
  sessions: "auction_sessions",
  products: "auction_products",
  auctions: "auction_auctions",
  bids: "auction_bids",
  orders: "auction_orders",
  history: "auction_history",
  danmakuMessages: "auction_danmaku_messages",
  danmakuBlockedUsers: "auction_danmaku_blocked_users"
} as const;

let pool: MysqlPool | null = null;
let schemaReady: Promise<void> | null = null;
let saveQueue = Promise.resolve();

export function isMysqlPersistenceConfigured() {
  return Boolean(
    process.env.AUCTION_STORAGE === "mysql" ||
      process.env.DATABASE_URL ||
      process.env.MYSQL_HOST ||
      process.env.MYSQL_DATABASE
  );
}

export async function loadMysqlState() {
  if (!isMysqlPersistenceConfigured()) {
    return null;
  }

  const mysqlPool = await getMysqlPool();
  await ensureSchema(mysqlPool);

  const state: PersistedAuctionState = {
    liveRooms: await loadRows<LiveRoom>(mysqlPool, MYSQL_TABLES.liveRooms),
    users: await loadRows<User>(mysqlPool, MYSQL_TABLES.users),
    sessions: await loadRows<Session>(mysqlPool, MYSQL_TABLES.sessions),
    products: await loadRows<Product>(mysqlPool, MYSQL_TABLES.products),
    auctions: await loadRows<Auction>(mysqlPool, MYSQL_TABLES.auctions),
    bids: await loadRows<Bid>(mysqlPool, MYSQL_TABLES.bids),
    orders: await loadRows<Order>(mysqlPool, MYSQL_TABLES.orders),
    history: await loadRows<AuctionHistoryItem>(mysqlPool, MYSQL_TABLES.history),
    danmakuMessages: await loadRows<DanmakuMessage>(mysqlPool, MYSQL_TABLES.danmakuMessages),
    danmakuBlockedUsers: await loadRows<DanmakuBlockedUser>(mysqlPool, MYSQL_TABLES.danmakuBlockedUsers)
  };

  return hasPersistedData(state) ? state : null;
}

export function saveMysqlState(state: PersistedAuctionState) {
  if (!isMysqlPersistenceConfigured()) {
    return Promise.resolve();
  }

  saveQueue = saveQueue
    .then(async () => {
      const mysqlPool = await getMysqlPool();
      await ensureSchema(mysqlPool);
      await writeState(mysqlPool, state);
    })
    .catch((error) => {
      console.warn(`MySQL 持久化失败，已保留 JSON 兜底：${getErrorMessage(error)}`);
    });

  return saveQueue;
}

async function getMysqlPool() {
  if (pool) {
    return pool;
  }

  const mysql = await loadMysqlModule();
  pool = mysql.createPool(getMysqlConfig());
  return pool;
}

async function loadMysqlModule(): Promise<MysqlModule> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string
  ) => Promise<MysqlModule>;

  return dynamicImport("mysql2/promise");
}

function getMysqlConfig() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  return {
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "",
    database: process.env.MYSQL_DATABASE ?? "realtime_auction",
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT ?? 10),
    charset: "utf8mb4"
  };
}

async function ensureSchema(mysqlPool: MysqlPool) {
  schemaReady ??= createSchema(mysqlPool);
  return schemaReady;
}

async function createSchema(mysqlPool: MysqlPool) {
  for (const table of Object.values(MYSQL_TABLES)) {
    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        entity_key VARCHAR(191) NOT NULL PRIMARY KEY,
        sort_order INT NOT NULL DEFAULT 0,
        data_json JSON NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_${table}_sort_order (sort_order)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }
}

async function loadRows<T>(mysqlPool: MysqlPool, table: string) {
  const [rows] = (await mysqlPool.query(
    `SELECT data_json FROM ${table} ORDER BY sort_order ASC, entity_key ASC`
  )) as [Array<{ data_json: string | T }>, unknown];

  return rows.map((row) => parseJsonValue<T>(row.data_json));
}

async function writeState(mysqlPool: MysqlPool, state: PersistedAuctionState) {
  const connection = await mysqlPool.getConnection();

  try {
    await connection.beginTransaction();
    await replaceRows(connection, MYSQL_TABLES.liveRooms, state.liveRooms, (item) => item.id);
    await replaceRows(connection, MYSQL_TABLES.users, state.users, (item) => item.id);
    await replaceRows(connection, MYSQL_TABLES.sessions, state.sessions, (item) => item.token);
    await replaceRows(connection, MYSQL_TABLES.products, state.products, (item) => item.id);
    await replaceRows(connection, MYSQL_TABLES.auctions, state.auctions, (item) => item.id);
    await replaceRows(connection, MYSQL_TABLES.bids, state.bids, (item) => item.id);
    await replaceRows(connection, MYSQL_TABLES.orders, state.orders, (item) => item.id);
    await replaceRows(connection, MYSQL_TABLES.history, state.history, (item, index) =>
      `${item.auction.id}:${item.archivedAt}:${index}`
    );
    await replaceRows(connection, MYSQL_TABLES.danmakuMessages, state.danmakuMessages, (item) => item.id);
    await replaceRows(connection, MYSQL_TABLES.danmakuBlockedUsers, state.danmakuBlockedUsers, (item) =>
      `${item.liveRoomId}:${item.userId}`
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function replaceRows<T>(
  connection: MysqlConnection,
  table: string,
  rows: T[],
  getKey: (row: T, index: number) => string
) {
  await connection.query(`DELETE FROM ${table}`);

  if (rows.length === 0) {
    return;
  }

  const values = rows.map((row, index) => [getKey(row, index), index, JSON.stringify(row)]);
  await connection.query(`INSERT INTO ${table} (entity_key, sort_order, data_json) VALUES ?`, [values]);
}

function parseJsonValue<T>(value: string | T) {
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

function hasPersistedData(state: PersistedAuctionState) {
  return Object.values(state).some((items) => items.length > 0);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
}
