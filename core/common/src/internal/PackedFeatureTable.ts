/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module Rendering
 */

import {
  assert, Id64, Id64String, UintArray,
} from "@itwin/core-bentley";
import { BatchType, ComputeNodeId, Feature, FeatureTable, ModelFeature, PackedFeature, PackedFeatureWithIndex, RenderFeatureTable } from "../FeatureTable";
import { GeometryClass } from "../GeometryParams";

/**
 * An immutable, packed representation of a [[FeatureTable]]. The features are packed into a single array of 32-bit integer values,
 * wherein each feature occupies 3 32-bit integers.
 * @internal
 */
export class PackedFeatureTable implements RenderFeatureTable {
  public readonly data: Uint32Array;
  public readonly batchModelId: Id64String;
  public readonly batchModelIdPair: Id64.Uint32Pair;
  public readonly numFeatures: number;
  public readonly anyDefined: boolean;
  public readonly type: BatchType;
  public animationNodeIds?: UintArray;

  public get byteLength(): number { return this.data.byteLength; }

  /** Construct a PackedFeatureTable from the packed binary data.
   * This is used internally when deserializing Tiles in iMdl format.
   * @internal
   */
  public constructor(data: Uint32Array, modelId: Id64String, numFeatures: number, type: BatchType, animationNodeIds?: UintArray) {
    this.data = data;
    this.batchModelId = modelId;
    this.batchModelIdPair = Id64.getUint32Pair(modelId);
    this.numFeatures = numFeatures;
    this.type = type;
    this.animationNodeIds = animationNodeIds;

    switch (this.numFeatures) {
      case 0:
        this.anyDefined = false;
        break;
      case 1:
        this.anyDefined = ModelFeature.isDefined(this.getFeature(0, ModelFeature.create()));
        break;
      default:
        this.anyDefined = true;
        break;
    }

    assert(this.data.length >= this._subCategoriesOffset);
    assert(undefined === this.animationNodeIds || this.animationNodeIds.length === this.numFeatures);
  }

  /** Create a packed feature table from a [[FeatureTable]]. */
  public static pack(featureTable: FeatureTable): PackedFeatureTable {
    // We must determine how many subcategories we have ahead of time to compute the size of the Uint32Array, as
    // the array cannot be resized after it is created.
    // We are not too worried about this as FeatureTables created on the front-end will contain few if any features; those obtained from the
    // back-end arrive within tiles already in the packed format.
    const subcategories = new Map<string, number>();
    for (const iv of featureTable.getArray()) {
      const found = subcategories.get(iv.value.subCategoryId.toString());
      if (undefined === found)
        subcategories.set(iv.value.subCategoryId, subcategories.size);
    }

    // We need 3 32-bit integers per feature, plus 2 32-bit integers per subcategory.
    const subCategoriesOffset = 3 * featureTable.length;
    const nUint32s = subCategoriesOffset + 2 * subcategories.size;
    const uint32s = new Uint32Array(nUint32s);

    for (const iv of featureTable.getArray()) {
      const feature = iv.value;
      const index = iv.index * 3;

      let subCategoryIndex = subcategories.get(feature.subCategoryId)!;
      assert(undefined !== subCategoryIndex); // we inserted it above...
      subCategoryIndex |= (feature.geometryClass << 24);

      uint32s[index + 0] = Id64.getLowerUint32(feature.elementId);
      uint32s[index + 1] = Id64.getUpperUint32(feature.elementId);
      uint32s[index + 2] = subCategoryIndex;
    }

    subcategories.forEach((index: number, id: string, _map) => {
      const index32 = subCategoriesOffset + 2 * index;
      uint32s[index32 + 0] = Id64.getLowerUint32(id);
      uint32s[index32 + 1] = Id64.getUpperUint32(id);
    });

    return new PackedFeatureTable(uint32s, featureTable.modelId, featureTable.length, featureTable.type);
  }

  /** Retrieve the Feature associated with the specified index. */
  public getFeature(featureIndex: number, result: ModelFeature): ModelFeature {
    const packed = this.getPackedFeature(featureIndex, scratchPackedFeature);
    return ModelFeature.unpack(packed, result, this.batchModelId);
  }

  /** Returns the Feature associated with the specified index, or undefined if the index is out of range. */
  public findFeature(featureIndex: number, result: ModelFeature): ModelFeature | undefined {
    return featureIndex < this.numFeatures ? this.getFeature(featureIndex, result) : undefined;
  }

  /** @internal */
  public getElementIdPair(featureIndex: number, out?: Id64.Uint32Pair): Id64.Uint32Pair {
    out = out ?? { lower: 0, upper: 0 };
    assert(featureIndex < this.numFeatures);
    const offset = 3 * featureIndex;
    out.lower = this.data[offset];
    out.upper = this.data[offset + 1];
    return out;
  }

  /** @internal */
  public getSubCategoryIdPair(featureIndex: number): Id64.Uint32Pair {
    const index = 3 * featureIndex;
    let subCatIndex = this.data[index + 2];
    subCatIndex = (subCatIndex & 0x00ffffff) >>> 0;
    subCatIndex = subCatIndex * 2 + this._subCategoriesOffset;
    return { lower: this.data[subCatIndex], upper: this.data[subCatIndex + 1] };
  }

  /** @internal */
  public getAnimationNodeId(featureIndex: number): number {
    return undefined !== this.animationNodeIds && featureIndex < this.numFeatures ? this.animationNodeIds[featureIndex] : 0;
  }

  /** @internal */
  public getPackedFeature(featureIndex: number, result: PackedFeature): PackedFeature {
    assert(featureIndex < this.numFeatures);

    const index32 = 3 * featureIndex;
    result.elementId.lower = this.data[index32];
    result.elementId.upper = this.data[index32 + 1];

    const subCatIndexAndClass = this.data[index32 + 2];
    result.geometryClass = (subCatIndexAndClass >>> 24) & 0xff;

    let subCatIndex = (subCatIndexAndClass & 0x00ffffff) >>> 0;
    subCatIndex = subCatIndex * 2 + this._subCategoriesOffset;
    result.subCategoryId.lower = this.data[subCatIndex];
    result.subCategoryId.upper = this.data[subCatIndex + 1];

    result.animationNodeId = this.getAnimationNodeId(featureIndex);
    result.modelId.lower = this.batchModelIdPair.lower;
    result.modelId.upper = this.batchModelIdPair.upper;

    return result;
  }

  public getModelIdPair(_featureIndex: number, out: Id64.Uint32Pair): Id64.Uint32Pair {
    out.lower = this.batchModelIdPair.lower;
    out.upper = this.batchModelIdPair.upper;
    return out;
  }

  /** Returns the element ID of the Feature associated with the specified index, or undefined if the index is out of range. */
  public findElementId(featureIndex: number): Id64String | undefined {
    if (featureIndex >= this.numFeatures)
      return undefined;
    else
      return this.readId(3 * featureIndex);
  }

  /** Return true if this table contains exactly 1 feature. */
  public get isUniform(): boolean { return 1 === this.numFeatures; }

  /** If this table contains exactly 1 feature, return it. */
  public getUniform(result: ModelFeature): ModelFeature | undefined {
    return this.isUniform ? this.getFeature(0, result) : undefined;
  }

  public get isVolumeClassifier(): boolean { return BatchType.VolumeClassifier === this.type; }
  public get isPlanarClassifier(): boolean { return BatchType.VolumeClassifier === this.type; }
  public get isClassifier(): boolean { return this.isVolumeClassifier || this.isPlanarClassifier; }

  /** Unpack the features into a [[FeatureTable]]. */
  public unpack(): FeatureTable {
    const table = new FeatureTable(this.numFeatures, this.batchModelId);
    const feature = ModelFeature.create();
    for (let i = 0; i < this.numFeatures; i++) {
      this.getFeature(i, feature);
      table.insertWithIndex(new Feature(feature.elementId, feature.subCategoryId, feature.geometryClass), i);
    }

    return table;
  }

  public populateAnimationNodeIds(computeNodeId: ComputeNodeId, maxNodeId: number): void {
    assert(undefined === this.animationNodeIds);
    this.animationNodeIds = populateAnimationNodeIds(this, computeNodeId, maxNodeId);
  }

  public * iterator(output: PackedFeatureWithIndex): Iterator<PackedFeatureWithIndex> {
    for (let i = 0; i < this.numFeatures; i++) {
      this.getPackedFeature(i, output);
      output.index = i;
      yield output;
    }
  }

  public iterable(output: PackedFeatureWithIndex): Iterable<PackedFeatureWithIndex> {
    return {
      [Symbol.iterator]: () => this.iterator(output),
    };
  }

  private get _subCategoriesOffset(): number { return this.numFeatures * 3; }

  private readId(offset32: number): Id64String {
    return Id64.fromUint32Pair(this.data[offset32], this.data[offset32 + 1]);
  }
}

interface PackedFeatureModelEntry {
  lastFeatureIndex: number;
  idLower: number;
  idUpper: number;
}

const scratchPackedFeatureModelEntry = { lastFeatureIndex: -1, idLower: -1, idUpper: -1 };

/** A table of model Ids associated with a [[MultiModelPackedFeatureTable]].
 * The feature indices in the packed feature table are grouped together by model, such that the first N features belong to model 1, the next M features to model 2, and so on.
 * The model table itself consists of one entry per model, where each entry looks like:
 *  indexOfLastFeatureInModel: u32
 *  modelId: u64
 * The modelId associated with a feature can therefore be derived by finding the entry in the model table with the highest indexOfLastFeatureInModel no greater than the feature index.
 * This lookup can be optimized using binary search.
 * Moreover, while iterating the feature table in sequence, the model table can be iterated in parallel so that no per-feature lookup of model Id is required.
 * @internal
 */
export class PackedFeatureModelTable {
  private readonly _data: Uint32Array;

  public constructor(data: Uint32Array) {
    this._data = data;
    assert(this._data.length % 3 === 0);
  }

  /** The number of models in the table. */
  public get length(): number {
    return this._data.length / 3;
  }

  public get byteLength(): number {
    return this._data.byteLength;
  }

  private getLastFeatureIndex(modelIndex: number): number {
    return this._data[modelIndex * 3];
  }

  public getEntry(modelIndex: number,  result: PackedFeatureModelEntry): PackedFeatureModelEntry {
    if (modelIndex >= this.length) {
      result.idLower = result.idUpper = 0;
      result.lastFeatureIndex = Number.MAX_SAFE_INTEGER;
      return result;
    }

    const index = modelIndex * 3;
    result.lastFeatureIndex = this._data[index + 0];
    result.idLower = this._data[index + 1];
    result.idUpper = this._data[index + 2];
    return result;
  }

  /** Get the Id of the model associated with the specified feature, or an invalid Id if the feature is not associated with any model. */
  public getModelIdPair(featureIndex: number, result?: Id64.Uint32Pair): Id64.Uint32Pair {
    if (!result)
      result = { lower: 0, upper: 0 };
    else
      result.lower = result.upper = 0;

    let first = 0;
    const last = this.length;
    let count = last;
    while (count > 0) {
      const step = Math.floor(count / 2);
      const mid = first + step;
      const lastFeatureIndex = this.getLastFeatureIndex(mid);
      if (featureIndex > lastFeatureIndex) {
        first = mid + 1;
        count -= step + 1;
      } else {
        count = step;
      }
    }

    if (first < last) {
      result.lower = this._data[first * 3 + 1];
      result.upper = this._data[first * 3 + 2];
    }

    return result;
  }
}

/** A PackedFeatureTable with a PackedFeatureModelTable appended to it, capable of storing features belonging to more than one model.
 * @internal
 */
export class MultiModelPackedFeatureTable implements RenderFeatureTable {
  private readonly _features: PackedFeatureTable;
  private readonly _models: PackedFeatureModelTable;

  public constructor(features: PackedFeatureTable, models: PackedFeatureModelTable) {
    this._features = features;
    this._models = models;
  }

  public static create(data: Uint32Array, batchModelId: Id64String, numFeatures: number, type: BatchType, numSubCategories: number): MultiModelPackedFeatureTable {
    const modelTableOffset = 3 * numFeatures + 2 * numSubCategories;
    const featureData = data.subarray(0, modelTableOffset);
    const features = new PackedFeatureTable(featureData, batchModelId, numFeatures, type);

    const modelData = data.subarray(modelTableOffset);
    const models = new PackedFeatureModelTable(modelData);

    return new MultiModelPackedFeatureTable(features, models);
  }

  public get batchModelId() { return this._features.batchModelId; }
  public get batchModelIdPair() { return this._features.batchModelIdPair; }
  public get numFeatures() { return this._features.numFeatures; }
  public get type() { return this._features.type; }
  public get animationNodeIds(): UintArray | undefined { return this._features.animationNodeIds; }
  public set animationNodeIds(ids: UintArray | undefined) { this._features.animationNodeIds = ids; }

  public get byteLength() {
    return this._features.byteLength + this._models.byteLength;
  }

  public getPackedFeature(featureIndex: number, result: PackedFeature): PackedFeature {
    this._features.getPackedFeature(featureIndex, result);
    this._models.getModelIdPair(featureIndex, result.modelId);
    return result;
  }

  public getFeature(featureIndex: number, result: ModelFeature): ModelFeature {
    const packed = this.getPackedFeature(featureIndex, scratchPackedFeature);
    return ModelFeature.unpack(packed, result);
  }

  public findFeature(featureIndex: number, result: ModelFeature): ModelFeature | undefined {
    return featureIndex < this.numFeatures ? this.getFeature(featureIndex, result) : undefined;
  }

  public getElementIdPair(featureIndex: number, out: Id64.Uint32Pair): Id64.Uint32Pair {
    return this._features.getElementIdPair(featureIndex, out);
  }

  public getModelIdPair(featureIndex: number, out: Id64.Uint32Pair): Id64.Uint32Pair {
    this._models.getModelIdPair(featureIndex, out);
    return out;
  }

  public findElementId(featureIndex: number): Id64String | undefined {
    return this._features.findElementId(featureIndex);
  }

  public * iterator(output: PackedFeatureWithIndex): Iterator<PackedFeatureWithIndex> {
    // Rather than perform a binary search on the model table to find each feature's model Id, traverse the model table in parallel with the feature table.
    let modelIndex = 0;
    const modelEntry = this._models.getEntry(modelIndex, scratchPackedFeatureModelEntry);

    for (let featureIndex = 0; featureIndex < this.numFeatures; featureIndex++) {
      if (featureIndex > modelEntry.lastFeatureIndex)
        this._models.getEntry(++modelIndex, modelEntry);

      this._features.getPackedFeature(featureIndex, output);
      output.modelId.lower = modelEntry.idLower;
      output.modelId.upper = modelEntry.idUpper;
      output.index = featureIndex;
      yield output;
    }
  }

  public iterable(output: PackedFeatureWithIndex): Iterable<PackedFeatureWithIndex> {
    return {
      [Symbol.iterator]: () => this.iterator(output),
    };
  }

  public getAnimationNodeId(featureIndex: number): number {
    return this._features.getAnimationNodeId(featureIndex);
  }

  public populateAnimationNodeIds(computeNodeId: ComputeNodeId, maxNodeId: number): void {
    this._features.animationNodeIds = populateAnimationNodeIds(this, computeNodeId, maxNodeId);
  }
}

export function createPackedFeature(): PackedFeature {
  const pair = { upper: 0, lower: 0 };
  return {
    modelId: { ...pair },
    elementId: { ...pair },
    subCategoryId: { ...pair },
    geometryClass: GeometryClass.Primary,
    animationNodeId: 0,
  };
}

const scratchPackedFeature = createPackedFeature();

function populateAnimationNodeIds(table: RenderFeatureTable, computeNodeId: ComputeNodeId, maxNodeId: number): UintArray | undefined {
  assert(maxNodeId > 0);

  let nodeIds;
  const outputFeature = PackedFeature.createWithIndex();
  for (const feature of table.iterable(outputFeature)) {
    const nodeId = computeNodeId(feature);
    assert(nodeId <= maxNodeId);
    if (0 !== nodeId) {
      if (!nodeIds) {
        const size = table.numFeatures;
        nodeIds = maxNodeId < 0x100 ? new Uint8Array(size) : (maxNodeId < 0x10000 ? new Uint16Array(size) : new Uint32Array(size));
      }

      nodeIds[feature.index] = nodeId;
    }
  }

  return nodeIds;
}

