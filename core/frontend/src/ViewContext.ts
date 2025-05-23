/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module Rendering
 */

import { assert, Id64String } from "@itwin/core-bentley";
import {
  Matrix3d, Point2d,
  Point3d, Range1d, Transform, XAndY,
} from "@itwin/core-geometry";
import { Frustum, FrustumPlanes, ViewFlags } from "@itwin/core-common";
import { CachedDecoration, DecorationsCache } from "./DecorationsCache";
import { IModelApp } from "./IModelApp";
import { PlanarClipMaskState } from "./PlanarClipMaskState";
import { CanvasDecoration } from "./render/CanvasDecoration";
import { Decorations } from "./render/Decorations";
import { GraphicBranch, GraphicBranchOptions } from "./render/GraphicBranch";
import { GraphicBuilder, ViewportGraphicBuilderOptions } from "./render/GraphicBuilder";
import { GraphicList, RenderGraphic } from "./render/RenderGraphic";
import { RenderPlanarClassifier } from "./internal/render/RenderPlanarClassifier";
import { RenderSystem, } from "./render/RenderSystem";
import { RenderTarget } from "./render/RenderTarget";
import { Scene } from "./render/Scene";
import { SpatialClassifierTileTreeReference, Tile, TileGraphicType, TileLoadStatus, TileTreeReference } from "./tile/internal";
import { ViewingSpace } from "./ViewingSpace";
import { ELEMENT_MARKED_FOR_REMOVAL, ScreenViewport, Viewport, ViewportDecorator } from "./Viewport";
import { ActiveSpatialClassifier } from "./SpatialClassifiersState";
import { GraphicType } from "./common/render/GraphicType";
import { RenderTextureDrape } from "./internal/render/RenderTextureDrape";

/** Provides context for producing [[RenderGraphic]]s for drawing within a [[Viewport]].
 * @public
 * @extensions
 */
export class RenderContext {
  /** ViewFlags extracted from the context's [[Viewport]]. */
  public readonly viewFlags: ViewFlags;
  private readonly _viewport: Viewport;
  /** Frustum extracted from the context's [[Viewport]]. */
  public readonly frustum: Frustum;
  /** Frustum planes extracted from the context's [[Viewport]]. */
  public readonly frustumPlanes: FrustumPlanes;

  constructor(vp: Viewport, frustum?: Frustum) {
    this._viewport = vp;
    this.viewFlags = vp.viewFlags;
    this.frustum = frustum ? frustum : vp.getFrustum();
    this.frustumPlanes = FrustumPlanes.fromFrustum(this.frustum);
  }

  /** Given a point in world coordinates, determine approximately how many pixels it occupies on screen based on this context's frustum. */
  public getPixelSizeAtPoint(inPoint?: Point3d): number {
    return this.viewport.viewingSpace.getPixelSizeAtPoint(inPoint);
  }

  /** The [[Viewport]] associated with this context. */
  public get viewport(): Viewport {
    return this._viewport;
  }

  /** The [[RenderSystem]] being used to produce graphics for this context. */
  public get renderSystem(): RenderSystem {
    return this.target.renderSystem;
  }

  /** @internal */
  public get target(): RenderTarget { return this.viewport.target; }

  /** @internal */
  protected _createGraphicBuilder(options: Omit<ViewportGraphicBuilderOptions, "viewport">): GraphicBuilder {
    return this.target.createGraphicBuilder({ ...options, viewport: this.viewport });
  }

  /** Create a builder for creating a [[GraphicType.Scene]] [[RenderGraphic]] for rendering within this context's [[Viewport]].
   * @param transform the local-to-world transform in which the builder's geometry is to be defined.
   * @returns A builder for creating a [[GraphicType.Scene]] [[RenderGraphic]] for rendering within this context's [[Viewport]].
   */
  public createSceneGraphicBuilder(transform?: Transform): GraphicBuilder {
    return this._createGraphicBuilder({ type: GraphicType.Scene, placement: transform });
  }

  /** Create a graphic from a [[GraphicBranch]]. */
  public createGraphicBranch(branch: GraphicBranch, location: Transform, opts?: GraphicBranchOptions): RenderGraphic {
    return this.target.renderSystem.createGraphicBranch(branch, location, opts);
  }

  /** Create a [[RenderGraphic]] which groups a set of graphics into a node in a scene graph, applying to each a transform and optional clip volume and symbology overrides.
   * @param branch Contains the group of graphics and the symbology overrides.
   * @param location the local-to-world transform applied to the grouped graphics.
   * @returns A RenderGraphic suitable for drawing the scene graph node within this context's [[Viewport]].
   * @see [[RenderSystem.createBranch]]
   */
  public createBranch(branch: GraphicBranch, location: Transform): RenderGraphic { return this.createGraphicBranch(branch, location); }

  /** Given the size of a logical pixel in meters, convert it to the size of a physical pixel in meters, if [[RenderSystem.dpiAwareLOD]] is `true`.
   * Used when computing LOD for graphics.
   * @internal
   */
  public adjustPixelSizeForLOD(cssPixelSize: number): number {
    return this.viewport.target.adjustPixelSizeForLOD(cssPixelSize);
  }
}

/** Provides context for an [[InteractiveTool]] to display decorations representing its current state.
 * @see [[InteractiveTool.onDynamicFrame]]
 * @public
 */
export class DynamicsContext extends RenderContext {
  private _foreground?: GraphicList;
  private _overlay?: GraphicList;

  /** Add a graphic to the list of dynamic graphics to be drawn in this context's [[Viewport]]. */
  public addGraphic(graphic: RenderGraphic): void {
    this.add(graphic, false);
  }

  /** @internal */
  public add(graphic: RenderGraphic, isOverlay: boolean) {
    const key = isOverlay ? "_overlay" : "_foreground";
    const list = this[key] ?? (this[key] = []);
    list.push(graphic);
  }

  /** @internal */
  public changeDynamics(): void {
    this.viewport.changeDynamics(this._foreground, this._overlay);
  }

  /** Create a builder for producing a [[RenderGraphic]] appropriate for rendering within this context's [[Viewport]].
   * @param options Options describing how to create the builder.
   * @returns A builder that produces a [[RenderGraphic]].
   */
  public createGraphic(options: Omit<ViewportGraphicBuilderOptions, "viewport">): GraphicBuilder {
    return this._createGraphicBuilder(options);
  }
}

/** Arguments supplied to [[DecorateContext.create]].
 * @public
 */
export interface DecorateContextCreateArgs {
  /** The viewport to be decorated. */
  viewport: ScreenViewport;
  /** The set of decoration graphics to be populated by the context. */
  output: Decorations;
  /** Optional cache. If omitted, one will be created.
   * @internal
   */
  cache?: DecorationsCache;
}

/** Provides context for a [[ViewportDecorator]] to add [[Decorations]] to be rendered within a [[Viewport]].
 * @public
 * @extensions
 */
export class DecorateContext extends RenderContext {
  private readonly _decorations: Decorations;
  private readonly _cache: DecorationsCache;
  private _curCacheableDecorator?: ViewportDecorator;

  /** The [[ScreenViewport]] in which this context's [[Decorations]] will be drawn. */
  public override get viewport(): ScreenViewport {
    return super.viewport as ScreenViewport;
  }

  /** @internal */
  constructor(vp: ScreenViewport, decorations: Decorations, cache: DecorationsCache) {
    super(vp);
    this._decorations = decorations;
    this._cache = cache;
  }

  /** Create a new DecorateContext.
   * @param args Describes the inputs to the context.
   * @note Typically the [[ScreenViewport]] takes care of creating the context for you.
   * @public
   */
  public static create(args: DecorateContextCreateArgs): DecorateContext {
    return new DecorateContext(args.viewport, args.output, args.cache ?? new DecorationsCache());
  }

  /** Create a builder for creating a [[RenderGraphic]] of the specified type appropriate for rendering within this context's [[Viewport]].
   * @param type The type of builder to create.
   * @param transform the local-to-world transform in which the builder's geometry is to be defined.
   * @param id If the decoration is to be pickable, a unique identifier to associate with the resultant [[RenderGraphic]].
   * @returns A builder for creating a [[RenderGraphic]] of the specified type appropriate for rendering within this context's [[Viewport]].
   * @see [[IModelConnection.transientIds]] for obtaining an ID for a pickable decoration.
   * @see [[createGraphic]] for more options.
   */
  public createGraphicBuilder(type: GraphicType, transform?: Transform, id?: Id64String): GraphicBuilder {
    return this.createGraphic({ type, placement: transform, pickable: undefined !== id ? { id } : undefined });
  }

  /** Create a builder for producing a [[RenderGraphic]] appropriate for rendering within this context's [[Viewport]].
   * @param options Options describing how to create the builder.
   * @returns A builder that produces a [[RenderGraphic]].
   */
  public createGraphic(options: Omit<ViewportGraphicBuilderOptions, "viewport">): GraphicBuilder {
    return this._createGraphicBuilder(options);
  }

  /** @internal */
  public addFromDecorator(decorator: ViewportDecorator): void {
    assert(undefined === this._curCacheableDecorator);
    try {
      if (decorator.useCachedDecorations) {
        const cached = this._cache.get(decorator);
        if (cached) {
          this.restoreCache(cached);
          return;
        }

        this._curCacheableDecorator = decorator;
      }

      decorator.decorate(this);
    } finally {
      this._curCacheableDecorator = undefined;
    }
  }

  /** Restores decorations onto this context from the specified array of cached decorations. */
  private restoreCache(cachedDecorations: CachedDecoration[]) {
    cachedDecorations.forEach((cachedDecoration) => {
      switch (cachedDecoration.type) {
        case "graphic":
          this.addDecoration(cachedDecoration.graphicType, cachedDecoration.graphicOwner);
          break;
        case "canvas":
          this.addCanvasDecoration(cachedDecoration.canvasDecoration, cachedDecoration.atFront);
          break;
        case "html":
          this.addHtmlDecoration(cachedDecoration.htmlElement);
          break;
      }
    });
  }

  private _appendToCache(decoration: CachedDecoration) {
    assert(undefined !== this._curCacheableDecorator);
    this._cache.add(this._curCacheableDecorator, decoration);
  }

  /** Calls [[GraphicBuilder.finish]] on the supplied builder to obtain a [[RenderGraphic]], then adds the graphic to the appropriate list of
   * [[Decorations]].
   * @param builder The builder from which to extract the graphic.
   * @note The builder should not be used after calling this method.
   */
  public addDecorationFromBuilder(builder: GraphicBuilder) {
    this.addDecoration(builder.type, builder.finish());
  }

  /** Adds a graphic to the set of [[Decorations]] to be drawn in this context's [[ScreenViewport]].
   * @param The type of the graphic, which determines to which list of decorations it is added.
   * @param decoration The decoration graphic to add.
   * @note The type must match the type with which the [[RenderGraphic]]'s [[GraphicBuilder]] was constructed.
   * @see [[DecorateContext.addDecorationFromBuilder]] for a more convenient API.
   */
  public addDecoration(type: GraphicType, decoration: RenderGraphic) {
    if (this._curCacheableDecorator) {
      const graphicOwner = this.target.renderSystem.createGraphicOwner(decoration);
      this._appendToCache({ type: "graphic", graphicOwner, graphicType: type });
      decoration = graphicOwner;
    }

    switch (type) {
      case GraphicType.Scene:
        if (undefined === this._decorations.normal)
          this._decorations.normal = [];
        this._decorations.normal.push(decoration);
        break;

      case GraphicType.WorldDecoration:
        if (!this._decorations.world)
          this._decorations.world = [];
        this._decorations.world.push(decoration);
        break;

      case GraphicType.WorldOverlay:
        if (!this._decorations.worldOverlay)
          this._decorations.worldOverlay = [];
        this._decorations.worldOverlay.push(decoration);
        break;

      case GraphicType.ViewOverlay:
        if (!this._decorations.viewOverlay)
          this._decorations.viewOverlay = [];
        this._decorations.viewOverlay.push(decoration);
        break;

      case GraphicType.ViewBackground:
        this.setViewBackground(decoration);
        break;
    }
  }

  /** Add a [[CanvasDecoration]] to be drawn in this context's [[ScreenViewport]]. */
  public addCanvasDecoration(decoration: CanvasDecoration, atFront = false) {
    if (this._curCacheableDecorator)
      this._appendToCache({ type: "canvas", canvasDecoration: decoration, atFront });

    if (undefined === this._decorations.canvasDecorations)
      this._decorations.canvasDecorations = [];

    const list = this._decorations.canvasDecorations;
    if (0 === list.length || true === atFront)
      list.push(decoration);
    else
      list.unshift(decoration);
  }

  /** Add an HTMLElement to be drawn as a decoration in this context's [[ScreenViewport]]. */
  public addHtmlDecoration(decoration: HTMLElement) {
    if (this._curCacheableDecorator)
      this._appendToCache({ type: "html", htmlElement: decoration });

    // an element decoration being added might already be on the decorationDiv, just marked for removal
    if (decoration[ELEMENT_MARKED_FOR_REMOVAL]) {
      decoration[ELEMENT_MARKED_FOR_REMOVAL] = false;
    } else if (decoration.parentElement !== this.viewport.decorationDiv) {
      this.viewport.decorationDiv.appendChild(decoration);
    }
  }

  /** @internal */
  public drawStandardGrid(gridOrigin: Point3d, rMatrix: Matrix3d, spacing: XAndY, gridsPerRef: number, _isoGrid: boolean = false, _fixedRepetitions?: Point2d): void {
    const vp = this.viewport;

    if (vp.viewingGlobe)
      return;

    const color = vp.getContrastToBackgroundColor();
    const planarGrid = this.viewport.target.renderSystem.createPlanarGrid(vp.getFrustum(), { origin: gridOrigin, rMatrix, spacing, gridsPerRef, color });
    if (planarGrid) {
      this.addDecoration(GraphicType.WorldDecoration, planarGrid);
    }
  }

  /** Display skyBox graphic that encompasses entire scene and rotates with camera.
   * @see [[RenderSystem.createSkyBox]].
   */
  public setSkyBox(graphic: RenderGraphic) {
    this._decorations.skyBox = graphic;
  }

  /** Set the graphic to be displayed behind all other geometry as the background of this context's [[ScreenViewport]]. */
  public setViewBackground(graphic: RenderGraphic) {
    this._decorations.viewBackground = graphic;
  }
}

/** Context used to create the scene to be drawn in a [[Viewport]]. The scene consists of a set of [[RenderGraphic]]s produced by the
 * [[TileTree]]s visible within the viewport. Creating the scene may result in the enqueueing of requests for [[Tile]] content which
 * should be displayed in the viewport but are not yet loaded.
 * @public
 */
export class SceneContext extends RenderContext {
  private _missingChildTiles = false;
  /** The graphics comprising the scene. */
  public readonly scene = new Scene();

  /** @internal */
  public readonly missingTiles = new Set<Tile>();

  /** @internal */
  public markChildrenLoading(): void {
    this._missingChildTiles = true;
  }

  /** @internal */
  public get hasMissingTiles(): boolean {
    return this._missingChildTiles || this.missingTiles.size > 0;
  }

  private _viewingSpace?: ViewingSpace;
  private _graphicType: TileGraphicType = TileGraphicType.Scene;

  public constructor(vp: Viewport, frustum?: Frustum) {
    super(vp, frustum);
  }

  /** The viewed volume containing the scene. */
  public get viewingSpace(): ViewingSpace {
    return undefined !== this._viewingSpace ? this._viewingSpace : this.viewport.viewingSpace;
  }

  /** @internal */
  public get graphicType() { return this._graphicType; }

  /** Add the specified graphic to the scene. */
  public outputGraphic(graphic: RenderGraphic): void {
    switch (this._graphicType) {
      case TileGraphicType.BackgroundMap:
        this.backgroundGraphics.push(graphic);
        break;
      case TileGraphicType.Overlay:
        this.overlayGraphics.push(graphic);
        break;
      default:
        this.graphics.push(graphic);
        break;
    }
  }

  /** Indicate that the specified tile is desired for the scene but is not yet ready. A request to load its contents will later be enqueued. */
  public insertMissingTile(tile: Tile): void {
    switch (tile.loadStatus) {
      case TileLoadStatus.NotLoaded:
      case TileLoadStatus.Queued:
      case TileLoadStatus.Loading:
        this.missingTiles.add(tile);
        break;
    }
  }

  /** @internal */
  public requestMissingTiles(): void {
    IModelApp.tileAdmin.requestTiles(this.viewport, this.missingTiles);
  }

  /** @internal */
  public addPlanarClassifier(classifiedModelId: Id64String, classifierTree?: SpatialClassifierTileTreeReference, planarClipMask?: PlanarClipMaskState): RenderPlanarClassifier | undefined {
    // Target may have the classifier from a previous frame; if not we must create one.
    let classifier = this.viewport.target.getPlanarClassifier(classifiedModelId);
    if (undefined === classifier)
      classifier = this.viewport.target.createPlanarClassifier(classifierTree?.activeClassifier);

    // Either way, we need to collect the graphics to draw for this frame, and record that we did so.
    if (undefined !== classifier) {
      this.planarClassifiers.set(classifiedModelId, classifier);
      classifier.setSource(classifierTree, planarClipMask);
    }

    return classifier;
  }

  /** @internal */
  public getPlanarClassifierForModel(modelId: Id64String) {
    return this.planarClassifiers.get(modelId);
  }

  /** @internal */
  public addBackgroundDrapedModel(drapedTreeRef: TileTreeReference, _heightRange: Range1d | undefined): RenderTextureDrape | undefined {
    const drapedTree = drapedTreeRef.treeOwner.tileTree;
    if (undefined === drapedTree)
      return undefined;

    const id = drapedTree.modelId;
    let drape = this.getTextureDrapeForModel(id);
    if (undefined !== drape)
      return drape;

    drape = this.viewport.target.getTextureDrape(id);
    if (undefined === drape && this.viewport.backgroundDrapeMap)
      drape = this.viewport.target.renderSystem.createBackgroundMapDrape(drapedTreeRef, this.viewport.backgroundDrapeMap);

    if (undefined !== drape)
      this.textureDrapes.set(id, drape);

    return drape;
  }

  /** @internal */
  public getTextureDrapeForModel(modelId: Id64String) {
    return this.textureDrapes.get(modelId);
  }

  /** @internal */
  public withGraphicType(type: TileGraphicType, func: () => void): void {
    const prevType = this._graphicType;
    this._graphicType = type;

    func();

    this._graphicType = prevType;
  }

  /** The graphics in the scene that will be drawn with depth. */
  public get graphics() { return this.scene.foreground; }
  /** The graphics that will be drawn behind everything else in the scene. */
  public get backgroundGraphics() { return this.scene.background; }
  /** The graphics that will be drawn in front of everything else in the scene. */
  public get overlayGraphics() { return this.scene.overlay; }
  /** @internal */
  public get planarClassifiers() { return this.scene.planarClassifiers; }
  /** @internal */
  public get textureDrapes() { return this.scene.textureDrapes; }

  /** @internal */
  public setVolumeClassifier(classifier: ActiveSpatialClassifier, modelId: Id64String): void {
    this.scene.volumeClassifier = { classifier, modelId };
  }
}
