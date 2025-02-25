/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/

/** @packageDocumentation
 * @module Curve
 */

import { CurvePrimitive } from "../curve/CurvePrimitive";

import type { GeometryHandler, IStrokeHandler } from "../geometry3d/GeometryHandler";
import type { Plane3dByOriginAndUnitNormal } from "../geometry3d/Plane3dByOriginAndUnitNormal";
import type { Plane3dByOriginAndVectors } from "../geometry3d/Plane3dByOriginAndVectors";
import type { Ray3d } from "../geometry3d/Ray3d";
import type { Transform } from "../geometry3d/Transform";
import type { Point3d, Vector3d } from "../geometry3d/Point3dVector3d";
import type { Range1d, Range3d } from "../geometry3d/Range";
import type { OffsetOptions } from "./internalContexts/PolygonOffsetContext";
import type { LineString3d } from "./LineString3d";
import type { StrokeOptions } from "./StrokeOptions";

/**
 * A ProxyCurve is expected to be used as a base class for
 * curve types that use some existing curve (the proxy) for evaluation and display
 * but carry other defining data.
 * * The ProxyCurve implements all required CurvePrimitive methods by dispatching
 *    to the proxy.
 * * These methods presumably require support from the application class and are left abstract:
 *    * clone
 *    * curvePrimitiveType
 *    * isSameCurvePrimitiveType
 *    * isSameGeometryClass
 *    * tryTransformInPlace
 *    * reverseInPlace
 *
 * @public
 */
export abstract class ProxyCurve extends CurvePrimitive {
  public dispatchToGeometryHandler(handler: GeometryHandler) {
    return this._proxyCurve.dispatchToGeometryHandler(handler);
  }

  protected _proxyCurve: CurvePrimitive;

  /** Constructor CAPTURES the proxyCurve pointer */
  public constructor(proxyCurve: CurvePrimitive) {
    super();
    this._proxyCurve = proxyCurve;
  }

  /** return the (pointer to) the proxy curve. */
  public get proxyCurve(): CurvePrimitive { return this._proxyCurve;}

  /** Implement by proxyCurve */
  public computeStrokeCountForOptions(options?: StrokeOptions): number {
    return this._proxyCurve.computeStrokeCountForOptions(options);
  }

  /** Implement by proxyCurve */
  public emitStrokableParts(dest: IStrokeHandler, options?: StrokeOptions): void{
    this._proxyCurve.emitStrokableParts(dest, options);
  }

  /** Return a deep clone. This override removes the undefined variant return. */
  public abstract override clone(): ProxyCurve;

  /** Return a transformed clone. */
  public override cloneTransformed(transform: Transform): ProxyCurve | undefined {
    const myClone = this.clone();
    if (myClone.tryTransformInPlace(transform))
      return myClone;
    return undefined;
  }

  /** Implement by proxyCurve. Subclasses may eventually override this default implementation. */
  public override clonePartialCurve(fractionA: number, fractionB: number): CurvePrimitive | undefined {
    return this._proxyCurve.clonePartialCurve(fractionA, fractionB);
  }

  /** Implement by proxyCurve */
  public emitStrokes(dest: LineString3d, options?: StrokeOptions): void{
    this._proxyCurve.emitStrokes(dest, options);
  }

  /** Implement by proxyCurve */
  public extendRange(rangeToExtend: Range3d, transform?: Transform): void{
    this._proxyCurve.extendRange (rangeToExtend, transform);
  }

  /** Implement by proxyCurve */
  public override range(transform?: Transform, result?: Range3d): Range3d {
    return this._proxyCurve.range(transform, result);
  }

  /** Implement by proxyCurve */
  public fractionToPoint(fraction: number, result?: Point3d): Point3d{
    return this._proxyCurve.fractionToPoint(fraction, result);
  }

  /** Implement by proxyCurve */
  public fractionToPointAndDerivative(fraction: number, result?: Ray3d): Ray3d{
    return this._proxyCurve.fractionToPointAndDerivative(fraction, result);
  }

  /** Implement by proxyCurve */
  public fractionToPointAnd2Derivatives(fraction: number, result?: Plane3dByOriginAndVectors): Plane3dByOriginAndVectors | undefined{
    return this._proxyCurve.fractionToPointAnd2Derivatives(fraction, result);
  }

  /** Implement by proxyCurve */
  public isInPlane(plane: Plane3dByOriginAndUnitNormal): boolean {
    return this._proxyCurve.isInPlane(plane);
  }

  /** Implement by proxyCurve */
  public quickLength(): number {
    return this._proxyCurve.quickLength();
  }

  /** Implement by proxyCurve */
  public override constructOffsetXY(offsetDistanceOrOptions: number | OffsetOptions): CurvePrimitive | CurvePrimitive[] | undefined {
    return this._proxyCurve.constructOffsetXY(offsetDistanceOrOptions);
  }

  /** Implement by proxyCurve */
  public override projectedParameterRange(ray: Vector3d | Ray3d, lowHigh?: Range1d): Range1d | undefined {
    return this._proxyCurve.projectedParameterRange(ray, lowHigh);
  }
}
