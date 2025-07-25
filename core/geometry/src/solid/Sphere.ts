/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/

/** @packageDocumentation
 * @module Solid
 */

import { Arc3d } from "../curve/Arc3d";
import { GeometryQuery } from "../curve/GeometryQuery";
import { LineString3d } from "../curve/LineString3d";
import { Loop } from "../curve/Loop";
import { StrokeOptions } from "../curve/StrokeOptions";
import { AxisOrder, Geometry } from "../Geometry";
import { Angle } from "../geometry3d/Angle";
import { AngleSweep } from "../geometry3d/AngleSweep";
import { GeometryHandler, UVSurface } from "../geometry3d/GeometryHandler";
import { Matrix3d } from "../geometry3d/Matrix3d";
import { Plane3dByOriginAndVectors } from "../geometry3d/Plane3dByOriginAndVectors";
import { Vector2d } from "../geometry3d/Point2dVector2d";
import { Point3d, Vector3d } from "../geometry3d/Point3dVector3d";
import { Range3d } from "../geometry3d/Range";
import { Transform } from "../geometry3d/Transform";
import { SolidPrimitive } from "./SolidPrimitive";

/**
 * A unit sphere mapped by an arbitrary [[Transform]].
 * * Typically, the stored matrix has orthogonal columns. In this case, if two columns have equal length, the
 * resulting geometry is ellipsoidal; if all three columns have equal length, the resulting geometry is a sphere.
 * * Creating a Sphere without orthogonal columns is possible but not recommended, for the resulting geometry
 * lacks portability; for example, such a Sphere cannot be represented as a DGN element (see [[createDgnSphere]]).
 * * An optional latitude sweep allows for partial spheres with or without caps.
 * * Compare to [[Ellipsoid]], which has the same parameterization, but acts as a closed [[Clipper]].
 * @public
 */
export class Sphere extends SolidPrimitive implements UVSurface {
  /** String name for schema properties */
  public readonly solidPrimitiveType = "sphere";

  private _localToWorld: Transform;  // local coordinates = unit sphere at origin
  private _latitudeSweep: AngleSweep;
  /** Return the latitude (in radians) all fractional v. */
  public vFractionToRadians(v: number): number {
    return this._latitudeSweep.fractionToRadians(v);
  }
  /** Return the longitude (in radians) all fractional u. */
  public uFractionToRadians(u: number): number {
    return u * Math.PI * 2.0;
  }

  /** Constructor CAPTURES inputs */
  private constructor(localToWorld: Transform, latitudeSweep: AngleSweep, capped: boolean) {
    super(capped);
    this._localToWorld = localToWorld;
    this._latitudeSweep = latitudeSweep;
    this._latitudeSweep.capLatitudeInPlace();
  }
  /** return a deep clone */
  public clone(): Sphere {
    return new Sphere(this._localToWorld.clone(), this._latitudeSweep.clone(), this.capped);
  }
  /**
   * Transform the sphere in place.
   * * Fails if the transform is singular.
   */
  public tryTransformInPlace(transform: Transform): boolean {
    if (transform.matrix.isSingular())
      return false;
    transform.multiplyTransformTransform(this._localToWorld, this._localToWorld);
    if (transform.matrix.determinant() < 0.0) {
      // if mirror, reverse z-axis to preserve outward normals
      this._localToWorld.matrix.scaleColumnsInPlace(1, 1, -1);
      this._latitudeSweep.setStartEndRadians(-this._latitudeSweep.endRadians, -this._latitudeSweep.startRadians);
    }
    return true;
  }
  /**
   * Return a transformed clone.
   * * Fails if the transform is singular.
  */
  public cloneTransformed(transform: Transform): Sphere | undefined {
    const result = this.clone();
    return result.tryTransformInPlace(transform) ? result : undefined;
  }
  /**
   * Construct a rigid coordinate frame from the local coordinate frame.
   * * The returned frame is right-handed, with perpendicular unit axes.
   * * Compare to [[cloneLocalToWorld]].
   */
  public getConstructiveFrame(): Transform | undefined {
    return this._localToWorld.cloneRigid();
  }
  /** Return the latitude sweep as fraction of south pole to north pole. */
  public get latitudeSweepFraction(): number { return this._latitudeSweep.sweepRadians / Math.PI; }
  /** Create from center and radius, with optional restricted latitudes. */
  public static createCenterRadius(center: Point3d, radius: number, latitudeSweep?: AngleSweep, capped?: boolean): Sphere {
    const localToWorld = Transform.createOriginAndMatrix(center, Matrix3d.createUniformScale(radius));
    return new Sphere(localToWorld, latitudeSweep ? latitudeSweep.clone() : AngleSweep.createFullLatitude(), capped ?? false);
  }
  /** Create an ellipsoid which is a unit sphere mapped to position by an (arbitrary, possibly skewed and scaled) transform. */
  public static createEllipsoid(localToWorld: Transform, latitudeSweep?: AngleSweep, capped?: boolean): Sphere | undefined {
    return new Sphere(localToWorld.clone(), latitudeSweep ? latitudeSweep.clone() : AngleSweep.createFullLatitude(), capped ?? false);
  }

  /**
   * Create a sphere from the typical parameters of the DGN file.
   * * This method normalizes the input vectors, squares `vectorX` against `vectorZ`, and scales the radii by the vectors' original lengths.
   * * These restrictions allow the sphere to be represented by an element in the DGN file.
   */
  public static createDgnSphere(center: Point3d, vectorX: Vector3d, vectorZ: Vector3d, radiusXY: number, radiusZ: number, latitudeSweep?: AngleSweep, capped?: boolean): Sphere | undefined {
    const rigidMatrix = Matrix3d.createRigidFromColumns(vectorZ, vectorX, AxisOrder.ZXY);
    if (rigidMatrix) {
      radiusXY *= vectorX.magnitude();
      rigidMatrix.scaleColumns(radiusXY, radiusXY, radiusZ * vectorZ.magnitude(), rigidMatrix);
      const frame = Transform.createOriginAndMatrix(center, rigidMatrix);
      return new Sphere(frame, latitudeSweep ? latitudeSweep.clone() : AngleSweep.createFullLatitude(), capped ?? false);
    }
    return undefined;
  }

  /**
   * Create a sphere.
   * * If `axes` is supplied, its columns are scaled by the radii to form the sphere's local frame.
  */
  public static createFromAxesAndScales(center: Point3d, axes: undefined | Matrix3d, radiusX: number, radiusY: number, radiusZ: number,
    latitudeSweep?: AngleSweep,
    capped?: boolean): Sphere | undefined {
    const localToWorld = Transform.createOriginAndMatrix(center, axes);
    localToWorld.matrix.scaleColumnsInPlace(radiusX, radiusY, radiusZ);
    return new Sphere(localToWorld, latitudeSweep ? latitudeSweep.clone() : AngleSweep.createFullLatitude(), capped ?? false);
  }

  /** return (copy of) sphere center */
  public cloneCenter(): Point3d { return this._localToWorld.getOrigin(); }
  /** return the (full length, i.e. scaled by radius) X vector from the sphere transform */
  public cloneVectorX(): Vector3d { return this._localToWorld.matrix.columnX(); }
  /** return the (full length, i.e. scaled by radius) Y vector from the sphere transform */
  public cloneVectorY(): Vector3d { return this._localToWorld.matrix.columnY(); }
  /** return the (full length, i.e. scaled by radius) Z vector from the sphere transform */
  public cloneVectorZ(): Vector3d { return this._localToWorld.matrix.columnZ(); }
  /** return (a copy of) the sphere's angle sweep. */
  public cloneLatitudeSweep(): AngleSweep { return this._latitudeSweep.clone(); }
  /** Test if the geometry is a true sphere taking the transform (which might have nonuniform scaling) is applied. */
  public trueSphereRadius(): number | undefined {
    const factors = this._localToWorld.matrix.factorRigidWithSignedScale();
    if (!factors) return undefined;
    if (factors && factors.scale > 0)   // why do we rule out mirror?
      return factors.scale;
    return undefined;
  }
  /**
   * Return the largest of the primary xyz axis radii
   */
  public maxAxisRadius(): number {
    const matrix = this._localToWorld.matrix;
    return Geometry.maxXYZ(matrix.columnXMagnitude(), matrix.columnYMagnitude(), matrix.columnZMagnitude());
  }
  /**
   * Return a (clone of) the sphere's local to world transformation.
   * * Compare to [[getConstructiveFrame]].
   */
  public cloneLocalToWorld(): Transform {
    return this._localToWorld.clone();
  }
  /** Test if `other` is a `Sphere` */
  public isSameGeometryClass(other: any): boolean { return other instanceof Sphere; }
  /** Test for same geometry in `other` */
  public override isAlmostEqual(other: GeometryQuery): boolean {
    if (other instanceof Sphere) {
      if (this.capped !== other.capped) return false;
      if (!this._localToWorld.isAlmostEqual(other._localToWorld)) return false;
      return true;
    }
    return false;
  }
  /**
   * Return strokes for the elliptical arc cross-section at latitude sweep fraction v.
   * * Optional inputs control the number of strokes along the cross-section:
   *   * If `fixedStrokeCount` is supplied, it is taken as the cross-section stroke count.
   *   * If `fixedStrokeCount` is undefined, stroke count is computed by applying `options` to the cross-section.
   *   * If neither input is supplied, the stroke count default is 16.
   *   * In any case, stroke count is clamped to the interval [4,64].
   * @param v fractional position along the sphere axis
   * @param fixedStrokeCount optional stroke count in u-direction
   * @param options optional stroke options in u-direction
   * @return strokes as line string
   */
  public strokeConstantVSection(v: number, fixedStrokeCount?: number, options?: StrokeOptions): LineString3d {
    let strokeCount = 16;
    if (fixedStrokeCount !== undefined && Number.isFinite(fixedStrokeCount)) {
      strokeCount = fixedStrokeCount;
    } else if (options instanceof StrokeOptions) {
      strokeCount = options.applyTolerancesToArc(Geometry.maxXY(this._localToWorld.matrix.columnXMagnitude(), this._localToWorld.matrix.columnYMagnitude()));
    }
    strokeCount = Geometry.clampToStartEnd(strokeCount, 4, 64);
    const transform = this._localToWorld;
    const phi = this.vFractionToRadians(v);
    const c1 = Math.cos(phi);
    const s1 = Math.sin(phi);
    let c0, s0;
    const result = LineString3d.createForStrokes(strokeCount, options);
    const deltaRadians = Math.PI * 2.0 / strokeCount;
    const fractions = result.fractions;     // possibly undefined !!!
    const derivatives = result.packedDerivatives; // possibly undefined !!!
    const uvParams = result.packedUVParams; // possibly undefined !!
    const surfaceNormals = result.packedSurfaceNormals;
    const dXdu = Vector3d.create();
    const dXdv = Vector3d.create();
    const normal = Vector3d.create();
    let radians = 0;
    for (let i = 0; i <= strokeCount; i++) {
      if (i * 2 <= strokeCount)
        radians = i * deltaRadians;
      else
        radians = (i - strokeCount) * deltaRadians;
      c0 = Math.cos(radians);
      s0 = Math.sin(radians);
      const xyz = transform.multiplyXYZ(c1 * c0, c1 * s0, s1);
      result.addPoint(xyz);

      if (fractions)
        fractions.push(i / strokeCount);

      if (derivatives) {
        transform.matrix.multiplyXYZ(-c1 * s0, c1 * c0, 0.0, dXdu);
        derivatives.push(dXdu);
      }
      if (uvParams) {
        uvParams.pushXY(i / strokeCount, v);
      }
      if (surfaceNormals) {
        transform.matrix.multiplyXYZ(-s0, c0, 0, dXdu);
        transform.matrix.multiplyXYZ(-s1 * c0, -s1 * s0, c1, dXdv);
        dXdu.unitCrossProduct(dXdv, normal);
        surfaceNormals.push(normal);
      }
    }
    return result;
  }

  /** Second step of double dispatch:  call `handler.handleSphere(this)` */
  public dispatchToGeometryHandler(handler: GeometryHandler): any {
    return handler.handleSphere(this);
  }

  /**
   * Return the Arc3d section at uFraction.  For the sphere, this is a meridian arc.
   * @param uFraction fractional position along the equator.
   */
  public constantUSection(uFraction: number): Arc3d {
    const phi = AngleSweep.fractionToSignedPeriodicFractionStartEnd(uFraction, 0, Angle.pi2Radians, false);
    const s1 = Math.sin(phi);
    const c1 = Math.cos(phi);
    const transform = this._localToWorld;
    const center = transform.getOrigin();
    const vector0 = transform.matrix.multiplyXYZ(c1, s1, 0);
    const vector90 = transform.matrix.multiplyXYZ(0, 0, 1);
    return Arc3d.create(center, vector0, vector90, this._latitudeSweep);
  }

  /**
   * Return the Arc3d section at vFraction.  For the sphere, this is a latitude circle.
   * @param vFraction fractional position along the sweep direction
   */
  public constantVSection(vFraction: number): Loop {
    const phi = this._latitudeSweep.fractionToRadians(vFraction);
    const s1 = Math.sin(phi);
    const c1 = Math.cos(phi);
    const transform = this._localToWorld;
    const center = transform.multiplyXYZ(0, 0, s1);
    const vector0 = transform.matrix.multiplyXYZ(c1, 0, 0);
    const vector90 = transform.matrix.multiplyXYZ(0, c1, 0);
    return Loop.create(Arc3d.create(center, vector0, vector90));
  }
  /** Extend a range to contain this sphere. */
  public extendRange(range: Range3d, transform?: Transform): void {
    let placement = this._localToWorld;
    if (transform) {
      placement = transform.multiplyTransformTransform(placement);
    }

    range.extendTransformedXYZ(placement, -1, -1, -1);
    range.extendTransformedXYZ(placement, 1, -1, -1);
    range.extendTransformedXYZ(placement, -1, 1, -1);
    range.extendTransformedXYZ(placement, 1, 1, -1);

    range.extendTransformedXYZ(placement, -1, -1, 1);
    range.extendTransformedXYZ(placement, 1, -1, 1);
    range.extendTransformedXYZ(placement, -1, 1, 1);
    range.extendTransformedXYZ(placement, 1, 1, 1);

  }
  /** Evaluate as a uv surface
   * @param uFraction fractional position on minor arc (theta, longitude)
   * @param vFraction fractional position on major arc (phi, latitude)
   */
  public uvFractionToPoint(uFraction: number, vFraction: number, result?: Point3d): Point3d {
    // sphere with radius 1 . . .
    const thetaRadians = this.uFractionToRadians(uFraction);
    const phiRadians = this.vFractionToRadians(vFraction);
    const cosTheta = Math.cos(thetaRadians);
    const sinTheta = Math.sin(thetaRadians);
    const sinPhi = Math.sin(phiRadians);
    const cosPhi = Math.cos(phiRadians);
    return this._localToWorld.multiplyXYZ(cosTheta * cosPhi, sinTheta * cosPhi, sinPhi, result);
  }
  /** Evaluate as a uv surface, returning point and two vectors.
   * @param uFraction fractional position on minor arc (theta, longitude)
   * @param vFraction fractional position on major arc (phi, latitude)
   */
  public uvFractionToPointAndTangents(uFraction: number, vFraction: number, result?: Plane3dByOriginAndVectors): Plane3dByOriginAndVectors {
    const thetaRadians = this.uFractionToRadians(uFraction);
    const phiRadians = this.vFractionToRadians(vFraction);
    const fTheta = Math.PI * 2.0;
    const fPhi = this._latitudeSweep.sweepRadians;
    const cosTheta = Math.cos(thetaRadians);
    const sinTheta = Math.sin(thetaRadians);
    const sinPhi = Math.sin(phiRadians);
    const cosPhi = Math.cos(phiRadians);
    return Plane3dByOriginAndVectors.createOriginAndVectors(
      this._localToWorld.multiplyXYZ(cosTheta * cosPhi, sinTheta * cosPhi, sinPhi),
      this._localToWorld.matrix.multiplyXYZ(-fTheta * sinTheta, fTheta * cosTheta, 0),   // NOTE: cosPhi scale is omitted, so the u-derivative scale is wrong but at least at the poles it's nonzero
      this._localToWorld.matrix.multiplyXYZ(-fPhi * cosTheta * sinPhi, -fPhi * sinTheta * sinPhi, fPhi * cosPhi),
      result);
  }
  /**
   * * A sphere is can be closed two ways:
   *   * full sphere (no caps needed for closure)
   *   * incomplete but with caps
   * @return true if this is a closed volume.
   */
  public get isClosedVolume(): boolean {
    return this.capped || this._latitudeSweep.isFullLatitudeSweep;
  }
  /**
   * Directional distance query
   * * u direction is around latitude circle at maximum distance from axis.
   * * v direction is on a line of longitude between the latitude limits.
   */
  public maxIsoParametricDistance(): Vector2d {
    // approximate radius at equator .. if elliptic, this is not exact . . .
    const rX = this._localToWorld.matrix.columnXMagnitude();
    const rY = this._localToWorld.matrix.columnYMagnitude();
    const rZ = this._localToWorld.matrix.columnZMagnitude();
    const rMaxU = Math.max(rX, rY);
    let dMaxU = Math.PI * 2.0 * rMaxU;
    if (!this._latitudeSweep.isRadiansInSweep(0.0))
      dMaxU *= Math.max(Math.cos(Math.abs(this._latitudeSweep.startRadians)), Math.cos(Math.abs(this._latitudeSweep.endRadians)));
    const dMaxV = Math.max(rMaxU, rZ) * Math.abs(this._latitudeSweep.sweepRadians);

    return Vector2d.create(dMaxU, dMaxV);
  }
}
