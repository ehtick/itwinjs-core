/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module Utils
 */

import type { Readable, Writable } from "stream"; // Must be "import type" to avoid webpack polyfill errors
import type { Buffer } from "buffer"; // Must be "import type" to avoid webpack polyfill errors

/*
IMPORTANT:
This is a temporary source file for backwards compatibility only.
Do not add any new types to this file.
All types here will be removed in 4.0
*/

/** BackendReadable and BackendWritable are not tagged internal for deprecated public RPC APIs which reference these types. */
/** @public @deprecated in 3.4.5 - might be removed in next major version. This type was mistakenly made public in the common scope. */
export type BackendReadable = Readable;

/** @public @deprecated in 3.4.5 - might be removed in next major version. This type was mistakenly made public in the common scope. */
export type BackendWritable = Writable;

/** @internal @deprecated in 3.4.5 - might be removed in next major version. This type was mistakenly made public in the common scope. */
export type BackendBuffer = Buffer;
