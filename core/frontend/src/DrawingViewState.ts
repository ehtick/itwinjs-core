/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module Views
 */

import { assert, dispose, Id64, Id64String } from "@itwin/core-bentley";
import {
  AxisAlignedBox3d, Frustum, HydrateViewStateRequestProps, HydrateViewStateResponseProps, QueryRowFormat, SectionDrawingViewProps, ViewDefinition2dProps, ViewFlagOverrides, ViewStateProps,
} from "@itwin/core-common";
import { Constant, Range3d, Transform, TransformProps, Vector3d } from "@itwin/core-geometry";
import { CategorySelectorState } from "./CategorySelectorState";
import { CoordSystem } from "./CoordSystem";
import { DisplayStyle2dState } from "./DisplayStyleState";
import { Frustum2d } from "./Frustum2d";
import { IModelApp } from "./IModelApp";
import { IModelConnection } from "./IModelConnection";
import { FeatureSymbology } from "./render/FeatureSymbology";
import { GraphicBranch, GraphicBranchOptions } from "./render/GraphicBranch";
import { MockRender } from "./internal/render/MockRender";
import { RenderGraphic } from "./render/RenderGraphic";
import { Scene } from "./render/Scene";
import { DisclosedTileTreeSet, TileGraphicType } from "./tile/internal";
import { SceneContext } from "./ViewContext";
import { OffScreenViewport, Viewport } from "./Viewport";
import { ViewRect } from "./common/ViewRect";
import { AttachToViewportArgs, ComputeDisplayTransformArgs, ExtentLimits, GetAttachmentViewportArgs, ViewState2d, ViewState3d } from "./ViewState";

/** Strictly for testing.
 * @internal
 */
export interface SectionDrawingInfo {
  readonly spatialView: Id64String;
  readonly drawingToSpatialTransform: Transform;
}

/** The information required to instantiate a [[SectionAttachment]]. This information is supplied to DrawingViewState constructor via ViewStateProps.
 * The spatial view is obtained asynchronously in DrawingViewState.load(). The SectionAttachment is created in DrawingViewState.attachToViewport and
 * disposed of in DrawingViewState.detachFromViewport.
 */
class SectionAttachmentInfo {
  private _spatialView: Id64String | ViewState3d;
  private readonly _drawingToSpatialTransform: Transform;
  private readonly _displaySpatialView: boolean;

  public get spatialView(): Id64String | ViewState3d { return this._spatialView; }
  public get wantDisplayed(): boolean {
    return this._displaySpatialView || DrawingViewState.alwaysDisplaySpatialView;
  }

  private constructor(spatialView: Id64String | ViewState3d, drawingToSpatialTransform: Transform, displaySpatialView: boolean) {
    this._spatialView = spatialView;
    this._drawingToSpatialTransform = drawingToSpatialTransform;
    this._displaySpatialView = displaySpatialView;
  }

  public static fromJSON(props?: SectionDrawingViewProps): SectionAttachmentInfo {
    if (!props)
      return new SectionAttachmentInfo(Id64.invalid, Transform.createIdentity(), false);

    return new SectionAttachmentInfo(props.spatialView, Transform.fromJSON(props.drawingToSpatialTransform), true === props.displaySpatialView);
  }

  public toJSON(): SectionDrawingViewProps | undefined {
    if ("string" === typeof this._spatialView && !Id64.isValidId64(this._spatialView))
      return undefined;

    return {
      spatialView: (this._spatialView instanceof ViewState3d) ? this._spatialView.id : this._spatialView,
      drawingToSpatialTransform: this._drawingToSpatialTransform.isIdentity ? undefined : this._drawingToSpatialTransform.toJSON(),
      displaySpatialView: this._displaySpatialView,
    };
  }

  public clone(iModel: IModelConnection): SectionAttachmentInfo {
    let spatialView = this._spatialView;
    if (spatialView instanceof ViewState3d)
      spatialView = spatialView.clone(iModel);

    return new SectionAttachmentInfo(spatialView, this._drawingToSpatialTransform, this._displaySpatialView);
  }

  public preload(options: HydrateViewStateRequestProps): void {
    if (!this.wantDisplayed)
      return;

    if (this._spatialView instanceof ViewState3d)
      return;

    if (!Id64.isValidId64(this._spatialView))
      return;

    options.spatialViewId = this._spatialView;
    options.viewStateLoadProps = {
      displayStyle: {
        omitScheduleScriptElementIds: !IModelApp.tileAdmin.enableFrontendScheduleScripts,
        compressExcludedElementIds: true,
      },
    };
  }

  public async load(iModel: IModelConnection): Promise<void> {
    if (!this.wantDisplayed)
      return;

    if (this._spatialView instanceof ViewState3d)
      return;

    if (!Id64.isValidId64(this._spatialView))
      return;

    const spatialView = await iModel.views.load(this._spatialView);
    if (spatialView instanceof ViewState3d)
      this._spatialView = spatialView;
  }

  public async postload(options: HydrateViewStateResponseProps, iModel: IModelConnection): Promise<void> {
    let spatialView;
    if (options.spatialViewProps) {
      spatialView = await iModel.views.convertViewStatePropsToViewState(options.spatialViewProps);
    }

    if (spatialView instanceof ViewState3d)
      this._spatialView = spatialView;
  }

  public createAttachment(toSheet: Transform | undefined): SectionAttachment | undefined {
    if (!this.wantDisplayed || !(this._spatialView instanceof ViewState3d))
      return undefined;

    const spatialToDrawing = this._drawingToSpatialTransform.inverse();
    return spatialToDrawing ? new SectionAttachment(this._spatialView, spatialToDrawing, this._drawingToSpatialTransform, toSheet) : undefined;
  }

  public get sectionDrawingInfo(): SectionDrawingInfo {
    return {
      drawingToSpatialTransform: this._drawingToSpatialTransform,
      spatialView: this._spatialView instanceof ViewState3d ? this._spatialView.id : this._spatialView,
    };
  }
}

/** A mostly no-op [[RenderTarget]] for a [[SectionAttachment]]. It allocates no webgl resources. */
class SectionTarget extends MockRender.OffScreenTarget {
  private readonly _attachment: SectionAttachment;

  public constructor(attachment: SectionAttachment) {
    super(IModelApp.renderSystem, new ViewRect(0, 0, 1, 1));
    this._attachment = attachment;
  }

  public override changeScene(scene: Scene): void {
    this._attachment.scene = scene;
  }

  public override overrideFeatureSymbology(ovrs: FeatureSymbology.Overrides): void {
    this._attachment.symbologyOverrides = ovrs;
  }
}

/** Draws the contents of an orthographic [[ViewState3d]] directly into a [[DrawingViewState]], if the associated [SectionDrawing]($backend)
 * specifies it should be. We select tiles for the view in the context of a lightweight offscreen viewport with a no-op [[RenderTarget]], then
 * add the resultant graphics to the drawing view's scene. The attachment is created in DrawingViewState.attachToViewport and disposed of in
 * DrawingViewState.detachFromViewport.
 */
class SectionAttachment {
  private readonly _viewFlagOverrides: ViewFlagOverrides;
  public readonly toDrawing: Transform;
  private readonly _fromDrawing: Transform;
  private readonly _viewRect = new ViewRect(0, 0, 1, 1);
  private readonly _originalFrustum = new Frustum();
  private readonly _drawingExtents: Vector3d;
  public readonly viewport: OffScreenViewport;
  private readonly _branchOptions: GraphicBranchOptions;
  public scene?: Scene;
  public symbologyOverrides: FeatureSymbology.Overrides;

  public get view(): ViewState3d {
    assert(this.viewport.view instanceof ViewState3d);
    return this.viewport.view;
  }

  public get zDepth(): number {
    return this._drawingExtents.z;
  }

  public get drawingRange() {
    const frustum3d = this._originalFrustum.transformBy(this.toDrawing);
    return frustum3d.toRange();
  }

  public constructor(view: ViewState3d, toDrawing: Transform, fromDrawing: Transform, toSheet: Transform | undefined) {
    // Save the input for clone(). Attach a copy to the viewport.
    this.toDrawing = toDrawing;
    this._fromDrawing = fromDrawing;

    this.viewport = OffScreenViewport.createViewport(view, new SectionTarget(this), true);

    this.symbologyOverrides = new FeatureSymbology.Overrides(view);
    let clipVolume;
    let clip = this.view.getViewClip();
    if (clip) {
      clip = clip.clone();
      const clipTransform = toSheet ? toSheet.multiplyTransformTransform(this.toDrawing) : this.toDrawing;
      clip.transformInPlace(clipTransform);
      clipVolume = IModelApp.renderSystem.createClipVolume(clip);
    }

    this._branchOptions = {
      clipVolume,
      hline: view.getDisplayStyle3d().settings.hiddenLineSettings,
      inSectionDrawingAttachment: true,
      frustum: {
        is3d: true,
        scale: { x: 1, y: 1 },
      },
      contours: view.getDisplayStyle3d().settings.contours
    };

    this._viewFlagOverrides = { ...view.viewFlags, lighting: false, shadows: false };

    // Save off the original frustum (potentially adjusted by viewport).
    this.viewport.setupFromView();
    this.viewport.viewingSpace.getFrustum(CoordSystem.World, true, this._originalFrustum);

    const drawingFrustum = this._originalFrustum.transformBy(this.toDrawing);
    const drawingRange = drawingFrustum.toRange();
    this._drawingExtents = drawingRange.diagonal();
    this._drawingExtents.z = Math.abs(this._drawingExtents.z);
  }

  public [Symbol.dispose](): void {
    this.viewport[Symbol.dispose]();
  }

  public addToScene(context: SceneContext): void {
    if (context.viewport.freezeScene)
      return;

    const pixelSize = context.viewport.getPixelSizeAtPoint();
    if (0 === pixelSize)
      return;

    // Adjust offscreen viewport's frustum based on intersection with drawing view frustum.
    const frustum3d = this._originalFrustum.transformBy(this.toDrawing);
    const frustumRange3d = frustum3d.toRange();
    const frustum2d = context.viewport.getWorldFrustum();
    const frustumRange2d = frustum2d.toRange();
    const intersect = frustumRange3d.intersect(frustumRange2d);
    if (intersect.isNull)
      return;

    frustum3d.initFromRange(intersect);
    frustum3d.transformBy(this._fromDrawing, frustum3d);
    this.viewport.setupViewFromFrustum(frustum3d);

    // Adjust view rect based on size of attachment on screen so tiles of appropriate LOD are selected.
    const width = this._drawingExtents.x * intersect.xLength() / frustumRange3d.xLength();
    const height = this._drawingExtents.y * intersect.yLength() / frustumRange3d.yLength();
    this._viewRect.width = Math.max(1, Math.round(width / pixelSize));
    this._viewRect.height = Math.max(1, Math.round(height / pixelSize));
    this.viewport.setRect(this._viewRect);

    // Propagate settings from drawing viewport.
    this.viewport.debugBoundingBoxes = context.viewport.debugBoundingBoxes;
    this.viewport.setTileSizeModifier(context.viewport.tileSizeModifier);

    // Create the scene.
    this.viewport.renderFrame();
    const scene = this.scene;
    if (!scene)
      return;

    // Extract graphics and insert into drawing's scene context.
    const outputGraphics = (source: RenderGraphic[]) => {
      if (0 === source.length)
        return;

      const graphics = new GraphicBranch();
      graphics.setViewFlagOverrides(this._viewFlagOverrides);
      graphics.symbologyOverrides = this.symbologyOverrides;

      for (const graphic of source)
        graphics.entries.push(graphic);

      const branch = context.createGraphicBranch(graphics, this.toDrawing, this._branchOptions);
      context.outputGraphic(branch);
    };

    outputGraphics(scene.foreground);
    context.withGraphicType(TileGraphicType.BackgroundMap, () => outputGraphics(scene.background));
    context.withGraphicType(TileGraphicType.Overlay, () => outputGraphics(scene.overlay));

    // Report tile statistics to drawing viewport.
    const tileAdmin = IModelApp.tileAdmin;
    const selectedAndReady = tileAdmin.getTilesForUser(this.viewport);
    const requested = tileAdmin.getRequestsForUser(this.viewport);
    tileAdmin.addExternalTilesForUser(context.viewport, {
      requested: requested?.size ?? 0,
      selected: selectedAndReady?.selected.size ?? 0,
      ready: selectedAndReady?.ready.size ?? 0,
    });
  }
}

/** A view of a [DrawingModel]($backend)
 * @public
 * @extensions
 */
export class DrawingViewState extends ViewState2d {
  public static override get className() { return "DrawingViewDefinition"; }

  /** Exposed strictly for testing and debugging. Indicates that when loading the view, the spatial view should be displayed even
   * if `SectionDrawing.displaySpatialView` is not `true`.
   * @internal
   */
  public static alwaysDisplaySpatialView = false;

  /** Exposed strictly for testing and debugging. Indicates that the 2d graphics should not be displayed.
   * @internal
   */
  public static hideDrawingGraphics = false;

  private readonly _viewedExtents: AxisAlignedBox3d;
  private _attachmentInfo: SectionAttachmentInfo;
  private _attachment?: SectionAttachment;

  /** Strictly for testing. @internal */
  public get sectionDrawingProps(): SectionDrawingViewProps | undefined {
    return this._attachmentInfo.toJSON();
  }

  /** Strictly for testing. @internal */
  public get sectionDrawingInfo() {
    return this._attachmentInfo.sectionDrawingInfo;
  }

  /** Strictly for testing. @internal */
  public get attachment(): object | undefined {
    return this._attachment;
  }

  /** Strictly for testing. @internal */
  public get attachmentInfo(): { spatialView: Id64String | ViewState3d } {
    return this._attachmentInfo;
  }

  public constructor(props: ViewDefinition2dProps, iModel: IModelConnection, categories: CategorySelectorState, displayStyle: DisplayStyle2dState, extents: AxisAlignedBox3d, sectionDrawing?: SectionDrawingViewProps) {
    super(props, iModel, categories, displayStyle);
    if (categories instanceof DrawingViewState) {
      this._viewedExtents = categories._viewedExtents.clone();
      this._attachmentInfo = categories._attachmentInfo.clone(iModel);
    } else {
      this._viewedExtents = extents;
      this._attachmentInfo = SectionAttachmentInfo.fromJSON(sectionDrawing);
    }
  }

  /** See [[ViewState.attachToViewport]]. */
  public override attachToViewport(args: AttachToViewportArgs): void {
    super.attachToViewport(args);
    assert(undefined === this._attachment);
    this._attachment = this._attachmentInfo.createAttachment(args.drawingToSheetTransform);
  }

  /** See [[ViewState.detachFromViewport]]. */
  public override detachFromViewport(): void {
    super.detachFromViewport();
    this._attachment = dispose(this._attachment);
  }

  public override async changeViewedModel(modelId: Id64String): Promise<void> {
    await super.changeViewedModel(modelId);
    const props = await this.querySectionDrawingProps();
    this._attachmentInfo = SectionAttachmentInfo.fromJSON(props);

    // super.changeViewedModel() throws if attached to viewport, and attachment only allocated while attached to viewport
    assert(undefined === this._attachment);
  }

  private async querySectionDrawingProps(): Promise<SectionDrawingViewProps> {
    let spatialView = Id64.invalid;
    let drawingToSpatialTransform: TransformProps | undefined;
    let displaySpatialView = false;
    try {
      const ecsql = `
        SELECT spatialView,
          json_extract(jsonProperties, '$.drawingToSpatialTransform') as drawingToSpatialTransform,
          CAST(json_extract(jsonProperties, '$.displaySpatialView') as BOOLEAN) as displaySpatialView
        FROM bis.SectionDrawing
        WHERE ECInstanceId=${this.baseModelId}`;

      for await (const row of this.iModel.createQueryReader(ecsql, undefined, { rowFormat: QueryRowFormat.UseJsPropertyNames })) {
        spatialView = Id64.fromJSON(row.spatialView?.id);
        displaySpatialView = !!row.displaySpatialView;
        try {
          drawingToSpatialTransform = JSON.parse(row.drawingToSpatialTransform);
        } catch {
          // We'll use identity transform.
        }

        break;
      }
    } catch {
      // The version of BisCore ECSchema in the iModel is probably too old to contain the SectionDrawing ECClass.
    }

    return { spatialView, displaySpatialView, drawingToSpatialTransform };
  }

  /** @internal */
  protected override preload(hydrateRequest: HydrateViewStateRequestProps): void {
    assert(!this.isAttachedToViewport);
    super.preload(hydrateRequest);
    this._attachmentInfo.preload(hydrateRequest);
  }

  /** @internal */
  protected override async postload(hydrateResponse: HydrateViewStateResponseProps): Promise<void> {
    const promises = [];
    promises.push(super.postload(hydrateResponse));
    promises.push(this._attachmentInfo.postload(hydrateResponse, this.iModel));
    await Promise.all(promises);
  }

  public static override createFromProps(props: ViewStateProps, iModel: IModelConnection): DrawingViewState {
    const cat = new CategorySelectorState(props.categorySelectorProps, iModel);
    const displayStyleState = new DisplayStyle2dState(props.displayStyleProps, iModel);
    const extents = props.modelExtents ? Range3d.fromJSON(props.modelExtents) : new Range3d();

    // use "new this" so subclasses are correct
    return new this(props.viewDefinitionProps as ViewDefinition2dProps, iModel, cat, displayStyleState, extents, props.sectionDrawing);
  }

  public override toProps(): ViewStateProps {
    const props = super.toProps();
    props.modelExtents = this._viewedExtents.toJSON();
    props.sectionDrawing = this._attachmentInfo.toJSON();
    return props;
  }

  public getViewedExtents(): AxisAlignedBox3d {
    const extents = this._viewedExtents.clone();
    if (this._attachment) {
      extents.extendRange(this._attachment.drawingRange);
    }

    return extents;
  }

  public get defaultExtentLimits(): ExtentLimits {
    return {
      min: Constant.oneMillimeter,
      max: 3 * Constant.diameterOfEarth,
    };
  }

  public override isDrawingView(): this is DrawingViewState { return true; }

  /** See [[ViewState.getOrigin]]. */
  public override getOrigin() {
    const origin = super.getOrigin();
    if (this._attachment)
      origin.z = -this._attachment.zDepth;

    return origin;
  }

  /** See [[ViewState.getExtents]]. */
  public override getExtents() {
    const extents = super.getExtents();
    if (this._attachment)
      extents.z = this._attachment.zDepth + Frustum2d.minimumZDistance;

    return extents;
  }

  /** @internal */
  public override discloseTileTrees(trees: DisclosedTileTreeSet): void {
    super.discloseTileTrees(trees);
    if (this._attachment)
      trees.disclose(this._attachment.viewport);
  }

  /** @internal */
  public override createScene(context: SceneContext): void {
    if (!DrawingViewState.hideDrawingGraphics)
      super.createScene(context);

    if (this._attachment)
      this._attachment.addToScene(context);
  }

  public override get areAllTileTreesLoaded(): boolean {
    return super.areAllTileTreesLoaded && (!this._attachment || this._attachment.view.areAllTileTreesLoaded);
  }

  /** @internal */
  public override get secondaryViewports() {
    return this._attachment ? [this._attachment.viewport] : super.secondaryViewports;
  }

  /** @internal */
  public override getAttachmentViewport(args: GetAttachmentViewportArgs): Viewport | undefined {
    const attach = args.inSectionDrawingAttachment ? this._attachment : undefined;
    return attach?.viewport;
  }

  /** @beta */
  public override computeDisplayTransform(args: ComputeDisplayTransformArgs): Transform | undefined {
    // ###TODO we're currently ignoring model and element Id in args, assuming irrelevant for drawings.
    // Should probably call super or have super call us.
    const attach = args.inSectionDrawingAttachment ? this._attachment : undefined;
    return attach?.toDrawing.clone(args.output);
  }
}
