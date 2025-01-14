/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module Rendering
 */

import { Id64String } from "@itwin/core-bentley";
import { BatchType, Feature, GeometryClass, ModelFeature } from "@itwin/core-common";
import { IModelConnection } from "../IModelConnection";

/** Describes aspects of a pixel as read from a [[Viewport]].
 * @see [[Viewport.readPixels]].
 * @public
 * @extensions
 */
export namespace Pixel {
  /** Describes a single pixel within a [[Pixel.Buffer]]. */
  export class Data {
    /** The feature that produced the pixel. */
    public readonly feature?: Feature;
    public readonly modelId?: Id64String;
    /** The pixel's depth in [[CoordSystem.Npc]] coordinates (0 to 1), or -1 if depth was not written or not requested. */
    public readonly distanceFraction: number;
    /** The type of geometry that produced the pixel. */
    public readonly type: GeometryType;
    /** The planarity of the geometry that produced the pixel. */
    public readonly planarity: Planarity;
    /** @internal */
    public readonly batchType?: BatchType;
    /** The iModel from which the geometry producing the pixel originated. */
    public readonly iModel?: IModelConnection;
    /** @internal */
    public readonly tileId?: string;
    /** @internal */
    public get isClassifier(): boolean {
      return undefined !== this.batchType && BatchType.Primary !== this.batchType;
    }

    /** @internal */
    public constructor(args?: {
      feature?: ModelFeature;
      distanceFraction?: number;
      type?: GeometryType;
      planarity?: Planarity;
      batchType?: BatchType;
      iModel?: IModelConnection;
      tileId?: string;
    }) {
      if (args?.feature)
        this.feature = new Feature(args.feature.elementId, args.feature.subCategoryId, args.feature.geometryClass);

      this.modelId = args?.feature?.modelId;
      this.distanceFraction = args?.distanceFraction ?? -1;
      this.type = args?.type ?? GeometryType.Unknown;
      this.planarity = args?.planarity ?? Planarity.Unknown;
      this.iModel = args?.iModel;
      this.tileId = args?.tileId;
    }

    /** The Id of the element that produced the pixel. */
    public get elementId(): Id64String | undefined {
      return this.feature?.elementId;
    }

    /** The Id of the [SubCategory]($backend) that produced the pixel. */
    public get subCategoryId(): Id64String | undefined {
      return this.feature?.subCategoryId;
    }

    /** The class of geometry that produced the pixel. */
    public get geometryClass(): GeometryClass | undefined {
      return this.feature?.geometryClass;
    }
  }

  /** Describes the type of geometry that produced the [[Pixel.Data]]. */
  export enum GeometryType {
    /** [[Pixel.Selector.GeometryAndDistance]] was not specified, or the type could not be determined. */
    Unknown, // Geometry was not selected, or type could not be determined
    /** No geometry was rendered to this pixel. */
    None,
    /** A surface produced this pixel. */
    Surface,
    /** A point primitive or polyline produced this pixel. */
    Linear,
    /** This pixel was produced by an edge of a surface. */
    Edge,
    /** This pixel was produced by a silhouette edge of a curved surface. */
    Silhouette,
  }

  /** Describes the planarity of the foremost geometry which produced the pixel. */
  export enum Planarity {
    /** [[Pixel.Selector.GeometryAndDistance]] was not specified, or the planarity could not be determined. */
    Unknown,
    /** No geometry was rendered to this pixel. */
    None,
    /** Planar geometry produced this pixel. */
    Planar,
    /** Non-planar geometry produced this pixel. */
    NonPlanar,
  }

  /**
   * Bit-mask by which callers of [[Viewport.readPixels]] specify which aspects are of interest.
   * Aspects not specified will be omitted from the returned data.
   */
  export enum Selector {
    None = 0,
    /** Select the [[Feature]] which produced each pixel. */
    Feature = 1 << 0, // eslint-disable-line @typescript-eslint/no-shadow
    /** Select the type and planarity of geometry which produced each pixel as well as the fraction of its distance between the near and far planes. */
    GeometryAndDistance = 1 << 2,
    /** Select all aspects of each pixel. */
    All = GeometryAndDistance | Feature,
  }

  /** A rectangular array of pixels as read from a [[Viewport]]'s frame buffer. Each pixel is represented as a [[Pixel.Data]] object.
   * The contents of the pixel buffer will be specified using device pixels, not CSS pixels. See [[Viewport.devicePixelRatio]] and [[Viewport.cssPixelsToDevicePixels]].
   * @see [[Viewport.readPixels]].
   */
  export interface Buffer {
    /** Retrieve the data associated with the pixel at (x,y) in view coordinates. */
    getPixel(x: number, y: number): Data;
  }

  /** A function which receives the results of a call to [[Viewport.readPixels]].
   * @note The contents of the buffer become invalid once the Receiver function returns. Do not store a reference to it.
   */
  export type Receiver = (pixels: Buffer | undefined) => void;
}
