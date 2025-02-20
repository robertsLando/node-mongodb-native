import type { Document } from '../bson';
import {
  isRetryableError,
  MongoCompatibilityError,
  MONGODB_ERROR_CODES,
  MongoError,
  MongoExpiredSessionError,
  MongoNetworkError,
  MongoRuntimeError,
  MongoServerError,
  MongoTransactionError
} from '../error';
import { ReadPreference } from '../read_preference';
import type { Server } from '../sdam/server';
import {
  sameServerSelector,
  secondaryWritableServerSelector,
  ServerSelector
} from '../sdam/server_selection';
import type { Topology } from '../sdam/topology';
import type { ClientSession } from '../sessions';
import { Callback, maxWireVersion, maybePromise, supportsRetryableWrites } from '../utils';
import { AbstractOperation, Aspect } from './operation';

const MMAPv1_RETRY_WRITES_ERROR_CODE = MONGODB_ERROR_CODES.IllegalOperation;
const MMAPv1_RETRY_WRITES_ERROR_MESSAGE =
  'This MongoDB deployment does not support retryable writes. Please add retryWrites=false to your connection string.';

type ResultTypeFromOperation<TOperation> = TOperation extends AbstractOperation<infer K>
  ? K
  : never;

/** @internal */
export interface ExecutionResult {
  /** The server selected for the operation */
  server: Server;
  /** The session used for this operation, may be implicitly created */
  session?: ClientSession;
  /** The raw server response for the operation */
  response: Document;
}

/**
 * Executes the given operation with provided arguments.
 * @internal
 *
 * @remarks
 * This method reduces large amounts of duplication in the entire codebase by providing
 * a single point for determining whether callbacks or promises should be used. Additionally
 * it allows for a single point of entry to provide features such as implicit sessions, which
 * are required by the Driver Sessions specification in the event that a ClientSession is
 * not provided
 *
 * @param topology - The topology to execute this operation on
 * @param operation - The operation to execute
 * @param callback - The command result callback
 */
export function executeOperation<
  T extends AbstractOperation<TResult>,
  TResult = ResultTypeFromOperation<T>
>(topology: Topology, operation: T): Promise<TResult>;
export function executeOperation<
  T extends AbstractOperation<TResult>,
  TResult = ResultTypeFromOperation<T>
>(topology: Topology, operation: T, callback: Callback<TResult>): void;
export function executeOperation<
  T extends AbstractOperation<TResult>,
  TResult = ResultTypeFromOperation<T>
>(topology: Topology, operation: T, callback?: Callback<TResult>): Promise<TResult> | void;
export function executeOperation<
  T extends AbstractOperation<TResult>,
  TResult = ResultTypeFromOperation<T>
>(topology: Topology, operation: T, callback?: Callback<TResult>): Promise<TResult> | void {
  if (!(operation instanceof AbstractOperation)) {
    // TODO(NODE-3483)
    throw new MongoRuntimeError('This method requires a valid operation instance');
  }

  return maybePromise(callback, cb => {
    if (topology.shouldCheckForSessionSupport()) {
      return topology.selectServer(ReadPreference.primaryPreferred, err => {
        if (err) return cb(err);

        executeOperation<T, TResult>(topology, operation, cb);
      });
    }

    // The driver sessions spec mandates that we implicitly create sessions for operations
    // that are not explicitly provided with a session.
    let session: ClientSession | undefined = operation.session;
    let owner: symbol | undefined;
    if (topology.hasSessionSupport()) {
      if (session == null) {
        owner = Symbol();
        session = topology.startSession({ owner, explicit: false });
      } else if (session.hasEnded) {
        return cb(new MongoExpiredSessionError('Use of expired sessions is not permitted'));
      } else if (session.snapshotEnabled && !topology.capabilities.supportsSnapshotReads) {
        return cb(new MongoCompatibilityError('Snapshot reads require MongoDB 5.0 or later'));
      }
    } else if (session) {
      // If the user passed an explicit session and we are still, after server selection,
      // trying to run against a topology that doesn't support sessions we error out.
      return cb(new MongoCompatibilityError('Current topology does not support sessions'));
    }

    try {
      executeWithServerSelection(topology, session, operation, (err, result) => {
        if (session && session.owner && session.owner === owner) {
          return session.endSession(err2 => cb(err2 || err, result));
        }

        cb(err, result);
      });
    } catch (e) {
      if (session && session.owner && session.owner === owner) {
        session.endSession();
      }

      throw e;
    }
  });
}

function supportsRetryableReads(server: Server) {
  return maxWireVersion(server) >= 6;
}

function executeWithServerSelection(
  topology: Topology,
  session: ClientSession | undefined,
  operation: AbstractOperation,
  callback: Callback
) {
  const readPreference = operation.readPreference || ReadPreference.primary;
  const inTransaction = session && session.inTransaction();

  if (inTransaction && !readPreference.equals(ReadPreference.primary)) {
    callback(
      new MongoTransactionError(
        `Read preference in a transaction must be primary, not: ${readPreference.mode}`
      )
    );

    return;
  }

  if (
    session &&
    session.isPinned &&
    session.transaction.isCommitted &&
    !operation.bypassPinningCheck
  ) {
    session.unpin();
  }

  let selector: ReadPreference | ServerSelector;

  if (operation.hasAspect(Aspect.CURSOR_ITERATING)) {
    // Get more operations must always select the same server, but run through
    // server selection to potentially force monitor checks if the server is
    // in an unknown state.
    selector = sameServerSelector(operation.server?.description);
  } else if (operation.trySecondaryWrite) {
    // If operation should try to write to secondary use the custom server selector
    // otherwise provide the read preference.
    selector = secondaryWritableServerSelector(topology.commonWireVersion, readPreference);
  } else {
    selector = readPreference;
  }

  const serverSelectionOptions = { session };
  function callbackWithRetry(err?: any, result?: any) {
    if (err == null) {
      return callback(undefined, result);
    }

    const hasReadAspect = operation.hasAspect(Aspect.READ_OPERATION);
    const hasWriteAspect = operation.hasAspect(Aspect.WRITE_OPERATION);
    const itShouldRetryWrite = shouldRetryWrite(err);

    if ((hasReadAspect && !isRetryableError(err)) || (hasWriteAspect && !itShouldRetryWrite)) {
      return callback(err);
    }

    if (
      hasWriteAspect &&
      itShouldRetryWrite &&
      err.code === MMAPv1_RETRY_WRITES_ERROR_CODE &&
      err.errmsg.match(/Transaction numbers/)
    ) {
      callback(
        new MongoServerError({
          message: MMAPv1_RETRY_WRITES_ERROR_MESSAGE,
          errmsg: MMAPv1_RETRY_WRITES_ERROR_MESSAGE,
          originalError: err
        })
      );

      return;
    }

    // select a new server, and attempt to retry the operation
    topology.selectServer(selector, serverSelectionOptions, (e?: any, server?: any) => {
      if (
        e ||
        (operation.hasAspect(Aspect.READ_OPERATION) && !supportsRetryableReads(server)) ||
        (operation.hasAspect(Aspect.WRITE_OPERATION) && !supportsRetryableWrites(server))
      ) {
        callback(e);
        return;
      }

      // If we have a cursor and the initial command fails with a network error,
      // we can retry it on another connection. So we need to check it back in, clear the
      // pool for the service id, and retry again.
      if (
        err &&
        err instanceof MongoNetworkError &&
        server.loadBalanced &&
        session &&
        session.isPinned &&
        !session.inTransaction() &&
        operation.hasAspect(Aspect.CURSOR_CREATING)
      ) {
        session.unpin({ force: true, forceClear: true });
      }

      operation.execute(server, session, callback);
    });
  }

  if (
    readPreference &&
    !readPreference.equals(ReadPreference.primary) &&
    session &&
    session.inTransaction()
  ) {
    callback(
      new MongoTransactionError(
        `Read preference in a transaction must be primary, not: ${readPreference.mode}`
      )
    );

    return;
  }

  // select a server, and execute the operation against it
  topology.selectServer(selector, serverSelectionOptions, (err?: any, server?: any) => {
    if (err) {
      callback(err);
      return;
    }

    if (session && operation.hasAspect(Aspect.RETRYABLE)) {
      const willRetryRead =
        topology.s.options.retryReads !== false &&
        !inTransaction &&
        supportsRetryableReads(server) &&
        operation.canRetryRead;

      const willRetryWrite =
        topology.s.options.retryWrites === true &&
        !inTransaction &&
        supportsRetryableWrites(server) &&
        operation.canRetryWrite;

      const hasReadAspect = operation.hasAspect(Aspect.READ_OPERATION);
      const hasWriteAspect = operation.hasAspect(Aspect.WRITE_OPERATION);

      if ((hasReadAspect && willRetryRead) || (hasWriteAspect && willRetryWrite)) {
        if (hasWriteAspect && willRetryWrite) {
          operation.options.willRetryWrite = true;
          session.incrementTransactionNumber();
        }

        operation.execute(server, session, callbackWithRetry);
        return;
      }
    }

    operation.execute(server, session, callback);
  });
}

function shouldRetryWrite(err: any) {
  return err instanceof MongoError && err.hasErrorLabel('RetryableWriteError');
}
