/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module Rendering
 */

import { RenderMemory } from "./RenderMemory";
import { Range3d } from "@itwin/core-geometry";

/** Abstract representation of an object which can be rendered by a [[RenderSystem]].
 * Two broad classes of graphics exist:
 *  - "Scene" graphics generated on the back-end to represent the contents of the models displayed in a [[Viewport]]; and
 *  - [[Decorations]] created on the front-end to be rendered along with the scene.
 * The latter are produced using a [[GraphicBuilder]].
 * @public
 * @extensions
 */
export abstract class RenderGraphic implements Disposable /* , RenderMemory.Consumer */ {
  public [Symbol.dispose](): void {
    this.dispose(); // eslint-disable-line @typescript-eslint/no-deprecated
  }

  /** @deprecated in 5.0 - will not be removed until after 2026-06-13. Will be made protected in a future release. Use [Symbol.dispose] instead. */
  public abstract dispose(): void; // eslint-disable-line @typescript-eslint/no-deprecated

  /** @internal */
  public abstract collectStatistics(stats: RenderMemory.Statistics): void;

  /** Extend `range` to include the bounding box of this graphic, including any child graphics.
  * @internal
  */
  public abstract unionRange(range: Range3d): void;
}

/** A graphic that owns another graphic. By default, every time a [[Viewport]]'s decorations or dynamics graphics change, the previous graphics are disposed of.
 * Use a GraphicOwner to prevent disposal of a graphic that you want to reuse. The graphic owner can be added to decorations and list of dynamics just like any other graphic, but the graphic it owns
 * will never be automatically disposed of. Instead, you assume responsibility for disposing of the owned graphic by calling [[disposeGraphic]] when the owned graphic is no longer in use. Failure
 * to do so will result in leaks of graphics memory or other webgl resources.
 * @public
 * @extensions
 */
export abstract class RenderGraphicOwner extends RenderGraphic {
  /** The owned graphic. */
  public abstract get graphic(): RenderGraphic;
  /** Does nothing. To dispose of the owned graphic, use [[disposeGraphic]]. */
  public dispose(): void { }
  /** Disposes of the owned graphic. */
  public disposeGraphic(): void { this.graphic[Symbol.dispose](); }
  /** @internal */
  public collectStatistics(stats: RenderMemory.Statistics): void { this.graphic.collectStatistics(stats); }
  /** @internal */
  public override unionRange(range: Range3d): void { this.graphic.unionRange(range); }
}

/** An array of [[RenderGraphic]]s.
 * @public
 * @extensions
 */
export type GraphicList = RenderGraphic[];
