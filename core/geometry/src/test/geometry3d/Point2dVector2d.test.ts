/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import { expect } from "chai";

import { PerpParallelOptions } from "../../Geometry";
import { Angle } from "../../geometry3d/Angle";
import { Point2dArrayCarrier } from "../../geometry3d/Point2dArrayCarrier";
import { Point2d, Vector2d } from "../../geometry3d/Point2dVector2d";
import { Point3d } from "../../geometry3d/Point3dVector3d";
import { Sample } from "../../serialization/GeometrySamples";
import * as bsiChecker from "../Checker";

describe("Point2d", () => {
  it("zeros", () => {
    const ck = new bsiChecker.Checker();
    const alwaysZero = Point2d.create(0, 0);
    const alwaysZeroA = Point2d.createZero();
    const alwaysZeroB = Point3d.createZero();
    ck.testTrue(alwaysZero.isExactEqual(alwaysZeroA));
    ck.testTrue(alwaysZero.isExactEqual(alwaysZeroB));

    const pointA = Point2d.create(1, 2);
    const epsilon = 1.0e-15;
    const pointB = Point2d.create(pointA.x, pointA.x + 0.01);
    ck.testFalse(Point2d.create(epsilon, epsilon).isAlmostEqualMetric(pointB), "is almost zero (epsilon)");
    ck.testFalse(pointA.isAlmostZero, "is almost zero");
    ck.testFalse(alwaysZero.isExactEqual(pointA));

    pointA.setZero();
    ck.testPoint2d(alwaysZero, pointA);
    ck.testTrue(alwaysZero.isAlmostZero, "is almost zero");
    ck.testTrue(Point2d.create(epsilon, epsilon).isAlmostZero, "is almost zero (epsilon)");
    ck.testTrue(Point2d.create(epsilon, epsilon).isAlmostEqualMetric(alwaysZero), "is almost zero (epsilon)");
    ck.testPoint2d(alwaysZero, alwaysZeroA);

    const p0 = Point2d.createFrom(undefined);
    ck.testExactNumber(0, p0.maxAbs());
    ck.checkpoint("Point2d.zeros");
    expect(ck.getNumErrors()).equals(0);
  });

  it("Diffs", () => {
    const ck = new bsiChecker.Checker();

    const pointA = Point2d.create(1, 2);
    const pointB = Point2d.create(-2, 5);

    const vectorAB = pointA.vectorTo(pointB);
    const pointDiff = pointA.maxDiff(pointB);
    const pointA3d = Point3d.createFrom(pointA);
    const pointB3d = Point3d.createFrom(pointB);
    pointA3d.z = 32.9;
    pointB3d.z = 29.1;
    const vectorMax = vectorAB.maxAbs();
    ck.testCoordinate(pointDiff, vectorMax, "maxDiff, maxAbs");
    ck.testCoordinate(vectorAB.magnitude(), pointA.distance(pointB), "distance and magnitude");
    ck.testCoordinate(vectorAB.magnitudeSquared(), pointA.distanceSquared(pointB), "distance and magnitude");
    const d3 = pointA3d.distanceXY(pointB3d);
    const pointDist = pointA.distance(pointB);
    ck.testCoordinate(pointDist, d3, "point3d.distanceXY");
    ck.testCoordinate(pointDist * pointDist, pointA3d.distanceSquaredXY(pointB3d), "point3d.distanceXY");

    ck.checkpoint("Point2d.Diffs");
    expect(ck.getNumErrors()).equals(0);
  });

  it("Diffs1", () => {
    const ck = new bsiChecker.Checker();
    const pointA = Point3d.create(1, 2);
    const pointB = Point3d.create(-2, 5);
    const vectorAB = pointA.vectorTo(pointB);
    const pointDiff = pointA.maxDiff(pointB);
    const vectorMax = vectorAB.maxAbs();
    ck.testCoordinate(pointDiff, vectorMax, "maxDiff, maxAbs");

    const pointA3d = Point3d.createFrom(pointA);
    const pointB3d = Point3d.createFrom(pointB);
    pointA3d.z = 32.9;
    pointB3d.z = 29.1;
    const vectorAB3d = pointA3d.vectorTo(pointB);
    const pointDiff3d = pointA3d.maxDiff(pointB);
    const vectorMax3d = vectorAB3d.maxAbs();
    ck.testCoordinate(pointDiff3d, vectorMax3d, "maxDiff, maxAbs");

    const symmetricLattice2 = Sample.createPoint2dLattice(-3, 1, 3);
    for (const point of symmetricLattice2) {
      const iMax = point.indexOfMaxAbs();
      const iMin = (iMax + 1) % 2;
      ck.testLE(Math.abs(point.at(iMin)), Math.abs(point.at(iMax)), "min less than max");
      ck.testExactNumber(Math.abs(point.at(iMax)), point.maxAbs(), "max abs versus index");
    }

    const boxI = Sample.createPoint2dLattice(1, 1, 2);
    const boxJ = Sample.createPoint2dLattice(1.25, 0.7, 2.55);
    const origin = Point2d.create(6.9, 0.11);
    const s1 = 0.23;
    const s2 = 0.91;
    const s3 = -1.49;
    const theta = Angle.createDegrees(20);
    const theta90 = Angle.createDegrees(90);
    const unitX = Vector2d.unitX();
    const unitY = Vector2d.unitY();
    const zero = Vector2d.createZero();
    ck.testExactNumber(0.0, zero.magnitude());

    for (const pointI of boxI) {
      const vectorI = origin.vectorTo(pointI);
      const vectorIES = Vector2d.createStartEnd(pointI, origin);
      const vectorIESNegated = vectorIES.negate();
      const unitPerp = vectorI.unitPerpendicularXY()!;
      ck.testVector2d(vectorI, vectorIESNegated);
      ck.testPerpendicular2d(vectorI, unitPerp);
      ck.testCoordinate(1, unitPerp.magnitude());

      const vectorI0 = vectorI.clone();
      ck.testVector2d(vectorI0, vectorI, "Vector2d.clone()");
      ck.testCoordinate(vectorI.x, unitX.dotProduct(vectorI));
      ck.testCoordinate(vectorI.y, unitY.dotProduct(vectorI));

      const rotateIXY = vectorI.rotateXY(theta);
      const rotateIXY90 = vectorI.rotate90CCWXY();
      const thetaXY = vectorI.angleTo(rotateIXY);
      const thetaXY90 = vectorI.angleTo(rotateIXY90);
      ck.testAngleNoShift(theta, thetaXY, "rotateXY, angleXY");
      ck.testAngleNoShift(thetaXY90, theta90, "rotate90XY, angleXY");

      for (const pointJ of boxJ) {
        const vectorJ = origin.vectorTo(pointJ);
        const signedAngle = vectorI.angleTo(vectorJ);
        ck.testAngleNoShift(
          vectorI.angleTo(vectorJ),
          signedAngle,
          "cross product used consistently for signed angle"
        );
        ck.testCoordinate(
          vectorJ.angleTo(vectorI).radians,
          -vectorI.angleTo(vectorJ).radians,
          "cross product used consistently for reverse order signed angle"
        );
        /*
        * ccw angle is positive and cw is negative. cross product is positive if thumb points up
        * in the right hand rule and is negative if thumb points down in the right hand rule.
        */
        ck.testLT(0, vectorI.crossProduct(vectorJ) * signedAngle.radians, "cross product sign agrees with signed angle");

        const vectorQ = Vector2d.create(1.2312321, 4.23);
        const vectorR = Vector2d.create(-0.23428, 1.231);
        ck.testPoint2d(
          origin.plus3Scaled(vectorI, s1, vectorJ, s2, vectorQ, s3),
          origin.plusScaled(vectorI, s1).plus2Scaled(vectorJ, s2, vectorQ, s3));
        ck.testVector2d(
          vectorR.plus3Scaled(vectorI, s1, vectorJ, s2, vectorQ, s3),
          vectorR.plusScaled(vectorI, s1).plus2Scaled(vectorJ, s2, vectorQ, s3)
        );

        /* be sure to exercise interpolate with fractions on both sides of 0.5 */
        const vectorIJ = pointI.vectorTo(pointJ);
        for (const fij of [-0.4, 0.12, 0.5, 0.78, 1.2]) {
          const vectorIJf = vectorI.interpolate(fij, vectorJ);
          ck.testVector2d(vectorIJf, vectorI.plusScaled(vectorIJ, fij));
        }

        const vectorIJV = vectorI.vectorTo(vectorJ);
        const unitIJV = vectorI.unitVectorTo(vectorJ);
        ck.testVector2d(vectorIJ, vectorIJV, "vectorTo between points, vectors");
        if (ck.testPointer(unitIJV)) {
          ck.testParallel2d(unitIJV, vectorIJ);
          ck.testCoordinate(unitIJV.dotProduct(vectorIJV), vectorI.distance(vectorJ));
        }

        const b = 2.5;
        const vectorIJb = vectorIJ.scaleToLength(b)!;
        ck.testCoordinate(vectorIJb.magnitude(), b);

        /* remark -- we trust that:
        * pointI and pointJ are never equal
        * vectorI and vectorJ are never equal or parallel
        * vectorI and vectorJ are never parallel to a principal axis
        */
        const unitIJ = pointI.unitVectorTo(pointJ)!;
        ck.testCoordinate(unitIJ.dotProduct(vectorIJ), pointI.distance(pointJ));
        const fIJ = vectorI.fractionOfProjectionToVector(vectorJ);
        const perpVector = vectorI.minus(vectorJ.scale(fIJ));
        ck.testPerpendicular2d(vectorJ, perpVector, "projection vector");

        const rotateI90 = vectorI.rotate90CCWXY();
        if (ck.testPointer(rotateI90)) {
          ck.testPerpendicular2d(vectorI, rotateI90);
        }
      }
    }
    ck.checkpoint("Point3d.Diffs");
    expect(ck.getNumErrors()).equals(0);
  });

  it("3dXY", () => {
    const ck = new bsiChecker.Checker();

    const pointA2d = Point2d.create(1, 2);
    const pointB2d = Point2d.create(-2, 5);
    const pointA3d = Point3d.createFrom(pointA2d);
    const pointB3d = Point3d.createFrom(pointB2d);
    pointA3d.z = 32.9;
    pointB3d.z = 29.1;
    const pointC2d = pointA2d.interpolateXY(0.3, 0.9, pointB2d);
    const pointC3d = pointA3d.interpolateXYZ(0.3, 0.9, 0.5, pointB3d);
    ck.testTrue(pointC3d.isAlmostEqualXY(pointC2d), "separately interpolated x,y");

    ck.checkpoint("Point2d.3dXY");
    expect(ck.getNumErrors()).equals(0);
  });

  it("Misc", () => {
    const ck = new bsiChecker.Checker();
    const data = { x: 1, y: 2 };
    const point0 = Point2d.createFrom(data);
    const vectorU = Vector2d.createFrom(data);
    const vectorV = Vector2d.create(4, -1);
    ck.testVector2d(vectorU, Vector2d.create(1, 2), "Vector2d.createFrom ()");
    ck.testVector2d(vectorU, Vector2d.createFrom(point0), "Vector2d.createFrom ()");

    const pointP = Point2d.create(3, 4);
    const pointPPlusU = pointP.plus(vectorU);
    const pointPlusUMinusU = pointPPlusU.minus(vectorU);
    ck.testPoint2d(pointP, pointPlusUMinusU, "add and subtract same vector");

    const pointA = Point2d.create(-2, 4);
    const pointB = pointA.plus(vectorU);
    const pointC = pointA.plus(vectorV);
    // note: vectorU = pointB - pointA and vectorV = pointC - pointA
    ck.testCoordinate(
      vectorU.dotProduct(vectorV),
      pointA.dotVectorsToTargets(pointB, pointC),
      "dotVectorsToTargets"
    );

    const fTangent = 1.8;
    const fPerp = 0.1;
    const pointD = pointA.addForwardLeft(fTangent, fPerp, vectorU);
    const gTangent = pointD.fractionOfProjectionToLine(pointA, pointB);
    const vectorD = Vector2d.createStartEnd(pointA, pointD);
    const gTangent2 = vectorD.fractionOfProjectionToVector(vectorU);
    ck.testCoordinate(fTangent, gTangent, "project to 2d line");
    ck.testCoordinate(fTangent, gTangent2, "project to 2d line");

    ck.checkpoint("Point2d.Misc");
    expect(ck.getNumErrors()).equals(0);
  });

  it("MiscA", () => {
    const ck = new bsiChecker.Checker();
    const a = Vector2d.create(5, 3);
    const b = Point2d.create(1, 2);
    const ja = a.toJSONXY();
    ck.testExactNumber(a.x, (ja as any).x);
    ck.testExactNumber(a.y, (ja as any).y);

    const a1 = a.clone();
    ck.testTrue(a1.isExactEqual(a));
    ck.testTrue(a1.isAlmostEqualXY(a.x, a.y));

    a.setFrom();
    b.setFrom();
    ck.testExactNumber(0, a.maxAbs());
    ck.testExactNumber(0, b.maxAbs());

    b.setFromJSON({ x: a.x, y: a.y });
    ck.testTrue(a.isExactEqual(b));
    ck.testTrue(a.isAlmostEqual(b));

    b.setFromJSON();
    ck.testExactNumber(0, b.maxAbs());
    a.freeze();

    expect(ck.getNumErrors()).equals(0);
  });

  it("MiscB", () => {
    const ck = new bsiChecker.Checker();
    const a = Vector2d.create(5, 3);
    const b = Vector2d.create(0, 0);
    ck.testFalse(a.isParallelTo(b));
    ck.testFalse(b.isParallelTo(a));

    a.set(3, 4);
    b.set(-3, -4);
    const c = Vector2d.create(-2, -9);
    ck.testTrue(a.isParallelTo(b, true));
    ck.testFalse(a.isParallelTo(b, false));
    ck.testFalse(a.isParallelTo(c));

    expect(ck.getNumErrors()).equals(0);
  });

  it("MiscC", () => {
    const ck = new bsiChecker.Checker();
    const a = Point2d.create(5, 2);
    const u = Vector2d.create(5, 3);
    const v = Vector2d.create(3, 1);
    const b = a.plus(u); // u = b - a
    ck.testCoordinate(v.dotProduct(u), v.dotProductStartEnd(a, b));

    const defaultFraction = 101.5;
    ck.testExactNumber(defaultFraction, b.fractionOfProjectionToLine(a, a, defaultFraction));

    expect(ck.getNumErrors()).equals(0);
  });

  it("MiscD", () => {
    const ck = new bsiChecker.Checker();
    const u = Vector2d.create(5, 3);
    const v0 = Vector2d.create(0, 0);
    ck.testExactNumber(0, u.fractionOfProjectionToVector(v0));

    const v1 = Vector2d.createFrom(new Float64Array([u.x, u.y])); // v1 = (5,3)
    const v2 = Vector2d.createFrom(new Float64Array([u.x])); // v2 = (5,0)
    const v3 = Vector2d.createFrom(new Float64Array(0)); // v3 = (0,0)
    ck.testVector2d(v1, u);
    ck.testVector2d(v2, Vector2d.create(u.x, 0));
    ck.testVector2d(v3, v0);
    ck.testUndefined(u.safeDivideOrNull(0));
    ck.testUndefined(v0.scaleToLength(1));

    const q = Vector2d.create(1, 2).normalize()!;
    const r = q.scale(-1.0);
    ck.testUndefined(Vector2d.createOffsetBisector(q, r, 2.0), "undefined bisector for opposite normals");

    expect(ck.getNumErrors()).equals(0);
  });

  it("Point2dArrayCarrier", () => {
    const ck = new bsiChecker.Checker();
    const pointArray = [Point2d.create(0, 0), Point2d.create(1, 0), Point2d.create(1, 1), Point2d.create(0, 1)];
    const carrier = new Point2dArrayCarrier(pointArray);
    for (let i = 0; i < carrier.length; i++) {
      ck.testUndefined(carrier.getPoint2dAtCheckedPointIndex(10 + i));
      ck.testUndefined(carrier.getVector2dAtCheckedVectorIndex(10 + i));
      ck.testUndefined(carrier.vectorIndexIndex(i, 10 + i));
      ck.testUndefined(carrier.vectorIndexIndex(10 + i, i));
    }
    ck.testUndefined(carrier.vectorXAndYIndex({ x: 1, y: 2 }, -3));
    ck.testUndefined(carrier.crossProductXAndYIndexIndex({ x: 1, y: 2 }, 20, 0));
    ck.testUndefined(carrier.crossProductXAndYIndexIndex({ x: 1, y: 2 }, 0, 20));
    ck.testUndefined(carrier.crossProductIndexIndexIndex(0, 1, 20));
    ck.testUndefined(carrier.crossProductIndexIndexIndex(10, 1, 0));
    ck.testUndefined(carrier.crossProductIndexIndexIndex(0, 21, 2));

    ck.testExactNumber(carrier.getXAtUncheckedPointIndex(0), 0);
    ck.testExactNumber(carrier.getYAtUncheckedPointIndex(0), 0);
    ck.testExactNumber(carrier.getXAtUncheckedPointIndex(1), 1);
    ck.testExactNumber(carrier.getYAtUncheckedPointIndex(1), 0);
    ck.testExactNumber(carrier.getXAtUncheckedPointIndex(2), 1);
    ck.testExactNumber(carrier.getYAtUncheckedPointIndex(2), 1);
    ck.testExactNumber(carrier.getXAtUncheckedPointIndex(3), 0);
    ck.testExactNumber(carrier.getYAtUncheckedPointIndex(3), 1);

    expect(ck.getNumErrors()).equals(0);
  });
});

describe("Vector2d.setAT", () => {
  it("Vector2d.setAT", () => {
    const point = Point2d.create(1, 2);
    const newX: number = 5;
    const newY: number = 6;
    point.setAt(0, newX);
    point.setAt(1, newY);
    expect(point.x).equal(newX);
    expect(point.y).equal(newY);
  });
});

describe("Vector2d.createOffsetBisector", () => {
  it("Vector2d.createOffsetBisector", () => {
    const sqrt2 = Math.sqrt(2);
    const unitPerpA: Vector2d = Vector2d.create(1 / sqrt2, 1 / sqrt2);
    const unitPerpB: Vector2d = Vector2d.create(-1 / sqrt2, 1 / sqrt2);
    const offset: number = 3;
    const expectedBisector: Vector2d = Vector2d.create(0, 3 * sqrt2);
    const outputBisector: Vector2d = Vector2d.createOffsetBisector(unitPerpA, unitPerpB, offset)!;
    expect(outputBisector).to.deep.equal(expectedBisector);
  });
});

describe("Vector2d.isParallelTo", () => {
  it("Vector2d.isParallelToWithZeroVector", () => {
    const thisVector: Vector2d = Vector2d.create(1, 2);
    const other: Vector2d = Vector2d.create(0, 0);
    const output: boolean = thisVector.isParallelTo(other);
    expect(output).equal(false);
  }),
    it("Vector2d.isParallelToTrueWithGivenTolerances", () => {
      const thisVector: Vector2d = Vector2d.create(1, 2);
      const other: Vector2d = Vector2d.create(1.01, 2.01);
      const options: PerpParallelOptions = { radianSquaredTol: 1, distanceSquaredTol: 1 };
      const output: boolean = thisVector.isParallelTo(other, undefined, undefined, options);
      expect(output).equal(true);
    }),
    it("Vector2d.isParallelToFalseWithGivenTolerances", () => {
      const thisVector: Vector2d = Vector2d.create(1, 2);
      const other: Vector2d = Vector2d.create(1.01, 2.01);
      const options: PerpParallelOptions = { radianSquaredTol: 1e-10, distanceSquaredTol: 1e-10 };
      const output: boolean = thisVector.isParallelTo(other, undefined, undefined, options);
      expect(output).equal(false);
    });
});

describe("Vector2d.isPerpendicularTo", () => {
  it("Vector2d.isPerpendicularToWithZeroVector", () => {
    const thisVector: Vector2d = Vector2d.create(1, 2);
    const other: Vector2d = Vector2d.create(0, 0);
    const output: boolean = thisVector.isPerpendicularTo(other);
    expect(output).equal(false);
  }),
    it("Vector2d.isPerpendicularToTrueWithGivenTolerances", () => {
      const thisVector: Vector2d = Vector2d.create(1, 2);
      const other: Vector2d = Vector2d.create(-2.01, 1.01);
      const options: PerpParallelOptions = { radianSquaredTol: 1, distanceSquaredTol: 1 };
      const output: boolean = thisVector.isPerpendicularTo(other, undefined, options);
      expect(output).equal(true);
    }),
    it("Vector2d.isPerpendicularToFalseWithGivenTolerances", () => {
      const thisVector: Vector2d = Vector2d.create(1, 2);
      const other: Vector2d = Vector2d.create(-2.01, 1.01);
      const options: PerpParallelOptions = { radianSquaredTol: 1e-10, distanceSquaredTol: 1e-10 };
      const output: boolean = thisVector.isPerpendicularTo(other, undefined, options);
      expect(output).equal(false);
    });
});
