/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module Tiles
 */

import { UintArray } from "@itwin/core-bentley";
import { LowAndHighXYZ, XYAndZ } from "@itwin/core-geometry";
import {
  ColorDefProps, FeatureIndexType, FillFlags, Gradient, LinePixels, PolylineTypeFlags, QParams2dProps, QParams3dProps,
} from "@itwin/core-common";
import { EdgeTable } from "../render/primitives/EdgeParams";
import { SurfaceMaterialAtlas, SurfaceType } from "../render/primitives/SurfaceParams";
import { AuxChannelTableProps } from "../render/primitives/AuxChannelTable";
import { ImdlAreaPattern, ImdlDocument } from "./ImdlSchema";

/** Types comprising the parsed representation of an ImdlDocument, produced by [[parseImdlDocument]] and consumed by [[decodeImdlGraphics]].
 * All of the types are required to support [structured cloning](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm) so that they
 * can be passed between workers and the main JavaScript thread.
 * @internal
 */
export namespace ImdlModel {
  export interface VertexTable {
    data: Uint8Array;
    usesUnquantizedPositions?: boolean;
    qparams: QParams3dProps;
    width: number;
    height: number;
    hasTranslucency: boolean;
    uniformColor?: ColorDefProps;
    featureIndexType: FeatureIndexType;
    uniformFeatureID?: number;
    numVertices: number;
    numRgbaPerVertex: number;
    uvParams?: QParams2dProps;
  }

  export interface PointStringParams {
    vertices: VertexTable;
    indices: Uint8Array;
    weight: number;
  }

  export interface TesselatedPolyline {
    indices: Uint8Array;
    prevIndices: Uint8Array;
    nextIndicesAndParams: Uint8Array;
  }

  export interface PolylineParams {
    vertices: VertexTable;
    polyline: TesselatedPolyline;
    isPlanar: boolean;
    type: PolylineTypeFlags;
    weight: number;
    linePixels: LinePixels;
  }

  export interface SegmentEdgeParams {
    indices: Uint8Array;
    endPointAndQuadIndices: Uint8Array;
  }

  export interface SilhouetteParams extends SegmentEdgeParams {
    normalPairs: Uint8Array;
  }

  export interface IndexedEdgeParams {
    indices: Uint8Array;
    edges: EdgeTable;
  }

  export interface EdgeParams {
    weight: number;
    linePixels: LinePixels;
    segments?: SegmentEdgeParams;
    silhouettes?: SilhouetteParams;
    polylines?: TesselatedPolyline;
    indexed?: IndexedEdgeParams;
  }

  export interface SurfaceMaterialParams {
    alpha?: number;
    diffuse?: {
      color?: ColorDefProps;
      weight?: number;
    };
    specular?: {
      color?: ColorDefProps;
      weight?: number;
      exponent?: number;
    };
  }

  export interface SurfaceRenderMaterial {
    isAtlas: false;
    material: string | SurfaceMaterialParams;
  }

  export type SurfaceMaterial = SurfaceRenderMaterial | SurfaceMaterialAtlas;

  export interface SurfaceParams {
    type: SurfaceType;
    indices: Uint8Array;
    fillFlags: FillFlags;
    hasBakedLighting: boolean;
    material?: SurfaceMaterial;
    textureMapping?: {
      texture: string | Gradient.SymbProps;
      alwaysDisplayed: boolean;
    };
  }

  export interface MeshParams {
    vertices: VertexTable;
    surface: SurfaceParams;
    edges?: EdgeParams;
    isPlanar: boolean;
    auxChannels?: AuxChannelTableProps;
  }

  export interface Instances {
    type: "instances";
    count: number;
    transforms: Float32Array;
    transformCenter: XYAndZ;
    featureIds?: Uint8Array;
    symbologyOverrides?: Uint8Array;
    range?: LowAndHighXYZ;
  }

  export interface ViewIndependentOrigin {
    type: "viewIndependentOrigin";
    origin: XYAndZ;
  }

  export type PrimitiveModifier = Instances | ViewIndependentOrigin;

  export type Primitive = {
    params: MeshParams;
    modifier?: PrimitiveModifier;
    type: "mesh";
  } | {
    params: PointStringParams;
    modifier?: PrimitiveModifier;
    type: "point";
  } | {
    params: PolylineParams;
    modifier?: PrimitiveModifier;
    type: "polyline";
  };

  export type AreaPatternParams = Omit<ImdlAreaPattern, "xyOffsets"> & {
    xyOffsets: Float32Array;
  };

  export type NodePrimitive = Primitive | {
    params: AreaPatternParams;
    modifier?: never;
    type: "pattern";
  };

  export interface BasicNode {
    primitives: NodePrimitive[];
    animationNodeId?: never;
    animationId?: never;
    layerId?: never;
  }

  export interface AnimationNode {
    primitives: NodePrimitive[];
    animationNodeId: number;
    animationId?: string;
    layerId?: never;
  }

  export interface Layer {
    primitives: NodePrimitive[];
    layerId: string;
    animationNodeId?: never;
    animationId?: never;
  }

  export type Node = BasicNode | AnimationNode | Layer;

  export interface SingleModelFeatureTable {
    multiModel: false;
    data: Uint32Array;
    numFeatures: number;
    animationNodeIds?: UintArray;
    numSubCategories?: never;
  }

  export interface MultiModelFeatureTable {
    multiModel: true;
    data: Uint32Array;
    numFeatures: number;
    numSubCategories: number;
    animationNodeIds?: UintArray;
  }

  export type FeatureTable = SingleModelFeatureTable | MultiModelFeatureTable;

  export interface Document {
    featureTable: FeatureTable;
    nodes: Node[];
    patterns: Map<string, Primitive[]>;
    rtcCenter?: XYAndZ;
    binaryData: Uint8Array;
    json: ImdlDocument;
  }
}
