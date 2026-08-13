/**
 * The storage surface the application is allowed to see.
 *
 * Deliberately shaped as a SUBSET OF THE REAL DRIVER'S API rather than as a new vocabulary of our
 * own. In direct mode the driver's own `Collection` satisfies this interface with no wrapper at all,
 * which means the fast path has zero translation cost and — more importantly — no place for a
 * translation bug to hide. The REST shim is then written to imitate the driver, not the other way
 * round, so moving from the gateway to Atlas is a change of one environment variable.
 *
 * Method names are the driver's (`findOne`, `toArray`) rather than the Python spec's
 * (`find_one`, `to_list`); the contract is identical, spelled the way this language spells it.
 */

export type Doc = Record<string, unknown>;
export type Filter = Record<string, unknown>;
export type Projection = Record<string, 0 | 1> | undefined;

/** An `update` document. Only the operators the app actually uses are supported by the shim. */
export type UpdateDoc = {
  $set?: Doc;
  $inc?: Record<string, number>;
  $setOnInsert?: Doc;
};

export interface StoreCursor<T = Doc> {
  sort(key: string | Record<string, 1 | -1>, direction?: 1 | -1): StoreCursor<T>;
  limit(n: number): StoreCursor<T>;
  toArray(): Promise<T[]>;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

export interface StoreCollection<T extends Doc = Doc> {
  find(filter?: Filter, options?: { projection?: Projection }): StoreCursor<T>;
  findOne(filter?: Filter, options?: { projection?: Projection }): Promise<T | null>;
  countDocuments(filter?: Filter): Promise<number>;

  insertOne(doc: T): Promise<unknown>;
  insertMany(docs: T[]): Promise<unknown>;
  updateOne(filter: Filter, update: UpdateDoc, options?: { upsert?: boolean }): Promise<unknown>;
  updateMany(filter: Filter, update: UpdateDoc, options?: { upsert?: boolean }): Promise<unknown>;
  deleteMany(filter: Filter): Promise<unknown>;
  findOneAndUpdate(
    filter: Filter,
    update: UpdateDoc,
    options?: { sort?: Record<string, 1 | -1>; returnDocument?: 'before' | 'after'; upsert?: boolean },
  ): Promise<T | null>;

  createIndex(spec: Record<string, 1 | -1>, options?: Record<string, unknown>): Promise<unknown>;
}

export interface StoreDatabase {
  collection<T extends Doc = Doc>(name: string): StoreCollection<T>;
}
