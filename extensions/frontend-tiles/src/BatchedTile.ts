/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/

import { assert, BeTimePoint, ByteStream, Logger } from "@itwin/core-bentley";
import { ColorDef, Tileset3dSchema } from "@itwin/core-common";
import {
  GltfReaderProps, GraphicBuilder, ImdlReader, IModelApp, RealityTileLoader, RenderSystem, Tile, TileBoundingBoxes, TileContent,
  TileDrawArgs, TileParams, TileRequest, TileRequestChannel, TileTreeLoadStatus, TileUser, TileVisibility, Viewport,
} from "@itwin/core-frontend";
import { loggerCategory } from "./LoggerCategory";
import { BatchedTileTree } from "./BatchedTileTree";
import { BatchedTileContentReader } from "./BatchedTileContentReader";
import { getMaxLevelsToSkip } from "./FrontendTiles";

/** @internal */
export interface BatchedTileParams extends TileParams {
  childrenProps: Tileset3dSchema.Tile[] | undefined;
}

let channel: TileRequestChannel | undefined;

/** @internal */
export class BatchedTile extends Tile {
  private readonly _childrenProps?: Tileset3dSchema.Tile[];
  private readonly _unskippable: boolean;

  public get batchedTree(): BatchedTileTree {
    return this.tree as BatchedTileTree;
  }

  public constructor(params: BatchedTileParams, tree: BatchedTileTree) {
    super(params, tree);

    // The root tile never has content, so it doesn't count toward max levels to skip.
    this._unskippable = 0 === (this.depth % getMaxLevelsToSkip());

    if (params.childrenProps?.length)
      this._childrenProps = params.childrenProps;

    if (!this.contentId) {
      this.setIsReady();
      // mark "undisplayable"
      this._maximumSize = 0;
    }
  }

  private get _batchedChildren(): BatchedTile[] | undefined {
    return this.children as BatchedTile[] | undefined;
  }

  public override computeLoadPriority(viewports: Iterable<Viewport>, _users: Iterable<TileUser>): number {
    // Prioritize tiles closer to camera and center of attention (zoom point or screen center).
    return RealityTileLoader.computeTileLocationPriority(this, viewports, this.tree.iModelTransform);
  }

  public selectTiles(selected: Set<BatchedTile>, args: TileDrawArgs, closestDisplayableAncestor: BatchedTile | undefined): void {
    const vis = this.computeVisibility(args);
    if (TileVisibility.OutsideFrustum === vis)
      return;

    if (this._unskippable) {
      // Prevent this tile's content from being unloaded due to memory pressure.
      args.touchedTiles.add(this);
      args.markUsed(this);
    }

    closestDisplayableAncestor = this.hasGraphics ? this : closestDisplayableAncestor;
    if (TileVisibility.TooCoarse === vis && (this.isReady || !this._unskippable)) {
      args.markUsed(this);
      args.markReady(this);
      const childrenLoadStatus = this.loadChildren();
      if (TileTreeLoadStatus.Loading === childrenLoadStatus)
        args.markChildrenLoading();

      const children = this._batchedChildren;
      if (children) {
        for (const child of children)
          child.selectTiles(selected, args, closestDisplayableAncestor);

        return;
      }
    }

    // We want to display this tile. Request its content if not already loaded.
    if ((TileVisibility.Visible === vis || this._unskippable) && !this.isReady)
      args.insertMissing(this);

    if (closestDisplayableAncestor)
      selected.add(closestDisplayableAncestor);
  }

  protected override _loadChildren(resolve: (children: Tile[] | undefined) => void, reject: (error: Error) => void): void {
    let children: BatchedTile[] | undefined;
    if (this._childrenProps) {
      try {
        for (const childProps of this._childrenProps) {
          const params = this.batchedTree.reader.readTileParams(childProps, this);
          const child = new BatchedTile(params, this.batchedTree);
          children = children ?? [];
          children.push(child);
        }
      } catch (err) {
        Logger.logException(loggerCategory, err);
        children = undefined;
        if (err instanceof Error)
          reject(err);
      }
    }

    resolve(children);
  }

  public override get channel(): TileRequestChannel {
    if (!channel) {
      channel = new TileRequestChannel("itwinjs-batched-models", 20);
      IModelApp.tileAdmin.channels.add(channel);
    }

    return channel;
  }

  public override async requestContent(_isCanceled: () => boolean): Promise<TileRequest.Response> {
    const url = new URL(this.contentId, this.batchedTree.reader.baseUrl);
    url.search = this.batchedTree.reader.baseUrl.search;
    const response = await fetch(url.toString());
    return response.arrayBuffer();
  }

  public override async readContent(data: TileRequest.ResponseData, system: RenderSystem, shouldAbort?: () => boolean): Promise<TileContent> {
    assert(data instanceof Uint8Array);
    if (!(data instanceof Uint8Array))
      return { };

    let reader: ImdlReader | BatchedTileContentReader | undefined = ImdlReader.create({
      stream: ByteStream.fromUint8Array(data),
      iModel: this.tree.iModel,
      modelId: this.tree.modelId,
      is3d: true,
      isLeaf: this.isLeaf,
      system,
      isCanceled: shouldAbort,
      timeline: this.batchedTree.scheduleScript,
      options: {
        tileId: this.contentId,
      },
    });

    if (!reader) {
      const gltfProps = GltfReaderProps.create(data, false, this.batchedTree.reader.baseUrl);
      if (gltfProps) {
        reader = new BatchedTileContentReader({
          props: gltfProps,
          iModel: this.tree.iModel,
          system,
          shouldAbort,
          vertexTableRequired: true,
          modelId: this.tree.modelId,
          isLeaf: this.isLeaf,
          range: this.range,
        });
      }
    }

    if (!reader)
      return { };

    return reader.read();
  }

  protected override addRangeGraphic(builder: GraphicBuilder, type: TileBoundingBoxes): void {
    if (TileBoundingBoxes.ChildVolumes !== type) {
      super.addRangeGraphic(builder, type);
      return;
    }

    builder.setSymbology(ColorDef.green, ColorDef.green, 2);
    builder.addRangeBox(this.range);

    this.loadChildren();
    const children = this.children;
    if (!children)
      return;

    builder.setSymbology(ColorDef.blue, ColorDef.blue.withTransparency(0xdf), 1);
    for (const child of children) {
      const range = child.range;
      builder.addRangeBox(range);
      builder.addRangeBox(range, true);
    }
  }

  public prune(olderThan: BeTimePoint): void {
    const children = this._batchedChildren;
    if (!children)
      return;

    if (this.usageMarker.isExpired(olderThan)) {
      this.disposeChildren();
    } else {
      for (const child of children)
        child.prune(olderThan);
    }
  }
}
