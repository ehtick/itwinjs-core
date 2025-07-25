/*---------------------------------------------------------------------------------------------
 * Copyright (c) Bentley Systems, Incorporated. All rights reserved.
 * See LICENSE.md in the project root for license terms and full copyright notice.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable @typescript-eslint/no-deprecated */
/** @packageDocumentation
 * @module UnifiedSelection
 */

import { Id64Arg } from "@itwin/core-bentley";
import { IModelRpcProps } from "@itwin/core-common";
import { IModelConnection } from "@itwin/core-frontend";
import {
  ClientDiagnosticsAttribute,
  ComputeSelectionRequestOptions,
  DEFAULT_KEYS_BATCH_SIZE,
  KeySet,
  KeySetJSON,
  SelectionScope,
  SelectionScopeProps,
  SelectionScopeRequestOptions,
} from "@itwin/presentation-common";
import { RpcRequestsHandler } from "@itwin/presentation-common/internal";

/**
 * Properties for creating [[SelectionScopesManager]].
 * @public
 * @deprecated in 5.0 - will not be removed until after 2026-06-13. Use `computeSelection` from [@itwin/unified-selection](https://github.com/iTwin/presentation/blob/master/packages/unified-selection/README.md#selection-scopes) package instead.
 */
export interface SelectionScopesManagerProps {
  /** RPC handler to use for requesting selection scopes */
  rpcRequestsHandler: {
    /** Requests available selection scopes */
    getSelectionScopes: (args: SelectionScopeRequestOptions<IModelRpcProps> & ClientDiagnosticsAttribute) => Promise<SelectionScope[]>;
    /** Requests keys to be added to logical selection based on provided element IDs and selection scope */
    computeSelection: (args: ComputeSelectionRequestOptions<IModelRpcProps> & ClientDiagnosticsAttribute) => Promise<KeySetJSON>;
  };

  /** Provider of active locale to use for localizing scopes */
  localeProvider?: () => string | undefined;
}

/**
 * A manager that knows available [selection scopes]($docs/presentation/unified-selection/index#selection-scopes)
 * and can compute logical selection based on element IDs and selection scope.
 *
 * @public
 * @deprecated in 5.0 - will not be removed until after 2026-06-13. Use `computeSelection` from [@itwin/unified-selection](https://github.com/iTwin/presentation/blob/master/packages/unified-selection/README.md#selection-scopes) package instead.
 */
export class SelectionScopesManager {
  private _rpcRequestsHandler: Pick<RpcRequestsHandler, "getSelectionScopes" | "computeSelection">;
  private _getLocale: () => string | undefined;
  private _activeScope: SelectionScopeProps | SelectionScope | string | undefined;

  public constructor(props: SelectionScopesManagerProps) {
    this._rpcRequestsHandler = props.rpcRequestsHandler;
    this._getLocale = props.localeProvider ? props.localeProvider : () => undefined;
  }

  /** Get active locale */
  public get activeLocale() {
    return this._getLocale();
  }

  /** The active selection scope or its id */
  public get activeScope() {
    return this._activeScope;
  }
  public set activeScope(scope: SelectionScopeProps | SelectionScope | string | undefined) {
    this._activeScope = scope;
  }

  /**
   * Get available selection scopes.
   * @param imodel The iModel to get selection scopes for
   * @param locale Optional locale to use when localizing scopes' label and description
   */
  public async getSelectionScopes(imodel: IModelConnection, locale?: string): Promise<SelectionScope[]> {
    if (!locale) {
      locale = this._getLocale();
    }
    return this._rpcRequestsHandler.getSelectionScopes({ imodel: imodel.getRpcProps(), locale });
  }

  /**
   * Computes keys that need to be added to logical selection based on provided selection scope.
   * @param ids Element IDs to compute selection for
   * @param scope Selection scope to apply
   */
  public async computeSelection(imodel: IModelConnection, ids: Id64Arg, scope: SelectionScopeProps | SelectionScope | string): Promise<KeySet> {
    const scopeProps = createSelectionScopeProps(scope);

    // convert ids input to array
    if (typeof ids === "string") {
      ids = [ids];
    } else if (ids instanceof Set) {
      ids = [...ids];
    }

    // compute selection in batches to avoid HTTP 413
    const keys = new KeySet();
    const batchSize = DEFAULT_KEYS_BATCH_SIZE;
    const batchesCount = Math.ceil(ids.length / batchSize);
    const batchKeyPromises = [];
    for (let batchIndex = 0; batchIndex < batchesCount; ++batchIndex) {
      const batchStart = batchSize * batchIndex;
      const batchEnd = batchStart + batchSize > ids.length ? ids.length : batchStart + batchSize;
      const batchIds = 0 === batchIndex && ids.length <= batchEnd ? ids : ids.slice(batchStart, batchEnd);
      batchKeyPromises.push(this._rpcRequestsHandler.computeSelection({ imodel: imodel.getRpcProps(), elementIds: batchIds, scope: scopeProps }));
    }
    const batchKeys = (await Promise.all(batchKeyPromises)).map((json) => KeySet.fromJSON(json));
    batchKeys.forEach((bk) => keys.add(bk));
    return keys;
  }
}

/**
 * Normalizes given scope options and returns [[SelectionScopeProps]] that can be used for
 * calculating selection with scope.
 *
 * @public
 * @deprecated in 5.0 - will not be removed until after 2026-06-13. Use `computeSelection` from [@itwin/unified-selection](https://github.com/iTwin/presentation/blob/master/packages/unified-selection/README.md#selection-scopes) package instead.
 */
export function createSelectionScopeProps(scope: SelectionScopeProps | SelectionScope | string | undefined): SelectionScopeProps {
  if (!scope) {
    return { id: "element" };
  }
  if (typeof scope === "string") {
    return { id: scope };
  }
  return scope;
}
