/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/

/** @packageDocumentation
 * @module Tools
 */

import { Id64String } from "@itwin/core-bentley";
import { PlanarClipMaskMode, PlanarClipMaskPriority, PlanarClipMaskSettings } from "@itwin/core-common";
import {
  BeButtonEvent, ContextRealityModelState, EventHandled, HitDetail, IModelApp, LocateFilterStatus, LocateResponse, PrimitiveTool, ScreenViewport, Tool,
} from "@itwin/core-frontend";
import { parseBoolean } from "./parseBoolean";

/** Set Map Masking by selected models.
 * @beta
 */
export class SetMapHigherPriorityMasking extends Tool {
  public static override toolId = "SetMapHigherPriorityMask";
  public static override get minArgs() { return 0; }
  public static override get maxArgs() { return 2; }

  public override async run(transparency: number, invert: boolean): Promise<boolean> {
    const vp = IModelApp.viewManager.selectedView;
    if (undefined === vp)
      return false;

    vp.changeBackgroundMapProps({ planarClipMask: { mode: PlanarClipMaskMode.Priority, priority: PlanarClipMaskPriority.BackgroundMap, transparency, invert } });
    vp.invalidateRenderPlan();
    return true;
  }

  public override async parseAndRun(...args: string[]): Promise<boolean> {
    const transparency = parseFloat(args[0]);
    let invert;
    if (args.length > 1)
      invert = parseBoolean(args[1]);
    return this.run((transparency !== undefined && transparency < 1.0) ? transparency : 0, invert === true);
  }
}

/** Unmask Mask.
 * @beta
 */
export class UnmaskMapTool extends Tool {
  public static override toolId = "UnmaskMap";
  public static override get minArgs() { return 0; }
  public static override get maxArgs() { return 0; }

  public override async run(): Promise<boolean> {
    const vp = IModelApp.viewManager.selectedView;
    if (undefined === vp)
      return false;

    vp.changeBackgroundMapProps({ planarClipMask: { mode: PlanarClipMaskMode.None, transparency: 0, invert: false } });
    vp.invalidateRenderPlan();
    return true;
  }
}

/** Base class for the reality model planar masking tools.
 * @beta
 */
export abstract class PlanarMaskBaseTool extends PrimitiveTool {
  protected readonly _acceptedModelIds = new Set<Id64String>();
  protected readonly _acceptedSubCategoryIds = new Set<Id64String>();
  protected readonly _acceptedElementIds = new Set<Id64String>();
  protected _transparency: number = 0;
  protected _useSelection: boolean = false;
  protected _invert: boolean = false;
  protected _targetMaskModel?: Id64String | ContextRealityModelState;

  public override requireWriteableTarget(): boolean { return false; }
  public override async onPostInstall() {
    await super.onPostInstall();
    this.setupAndPromptForNextAction();
  }

  public override async onUnsuspend() { this.showPrompt(); }
  private setupAndPromptForNextAction(): void {
    this._useSelection = (undefined !== this.targetView && this.iModel.selectionSet.isActive);
    this.initLocateElements(!this._useSelection || (this.targetModelRequired() && !this._targetMaskModel));
    IModelApp.locateManager.options.allowDecorations = true;    // So we can select "contextual" reality models.
    this.showPrompt();
  }
  protected targetModelRequired(): boolean { return true; }
  protected elementRequired(): boolean { return true; }
  protected allowSelection(): boolean { return true; }
  protected abstract showPrompt(): void;
  protected abstract createToolInstance(): PlanarMaskBaseTool;
  protected abstract applyMask(vp: ScreenViewport): void;
  private clearIds() {
    this._acceptedElementIds.clear();
    this._acceptedModelIds.clear();
  }
  public override async exitTool() {
    await super.exitTool();
    this._transparency = 0;
  }

  public async onRestartTool() {
    this.clearIds();
    this._acceptedSubCategoryIds.clear();
    const tool = this.createToolInstance();
    if (!await tool.run())
      await this.exitTool();
  }

  public override async parseAndRun(...args: string[]): Promise<boolean> {
    const transparency = parseFloat(args[0]);
    this._transparency = (transparency !== undefined && transparency < 1.0) ? transparency : 0;
    if (args.length > 1)
      this._invert = parseBoolean(args[1]) === true;

    return this.run();
  }

  public override async onCleanup() {
    if (0 !== this._acceptedElementIds.size)
      this.iModel.hilited.remove({ elements: this._acceptedElementIds });
    this.clearIds();
  }

  public override async filterHit(hit: HitDetail, _out?: LocateResponse): Promise<LocateFilterStatus> {
    if (!hit.modelId)
      return LocateFilterStatus.Reject;

    if (undefined === this._targetMaskModel && this.targetModelRequired()) {
      if (undefined !== hit.viewport.displayStyle.contextRealityModelStates.find((x) => x.modelId === hit.modelId))
        return LocateFilterStatus.Accept;

      const model = this.iModel.models.getLoaded(hit.modelId)?.asSpatialModel;
      return model?.isRealityModel ? LocateFilterStatus.Accept : LocateFilterStatus.Reject;
    } else
      return (hit.isElementHit && !hit.isModelHit && !this._acceptedElementIds.has(hit.sourceId)) ? LocateFilterStatus.Accept : LocateFilterStatus.Reject;
  }

  public override async onDataButtonDown(ev: BeButtonEvent): Promise<EventHandled> {
    const hit = await IModelApp.locateManager.doLocate(new LocateResponse(), true, ev.point, ev.viewport, ev.inputSource);
    const vp = IModelApp.viewManager.selectedView;
    if (undefined === vp)
      return EventHandled.No;

    if (undefined !== hit && undefined === this._targetMaskModel && this.targetModelRequired()) {
      if (hit.modelId) {
        this._targetMaskModel = hit.viewport.displayStyle.contextRealityModelStates.find((x) => x.modelId === hit.modelId) ?? hit.modelId;
        if (!this.elementRequired()) {
          this.applyMask(vp);
          await this.onRestartTool();
        }
      }
    } else if (this._useSelection && this.iModel.selectionSet.isActive) {
      const elements = await this.iModel.elements.getProps(this.iModel.selectionSet.elements);
      for (const element of elements) {
        if (element.id && element.model) {
          this._acceptedElementIds.add(element.id);
          this._acceptedModelIds.add(element.model);
        }
      }
      this.applyMask(vp);
      await this.exitTool();
      return EventHandled.No;
    } else if (undefined !== hit && hit.isElementHit) {
      const sourceId = hit.sourceId;
      if (!this._acceptedElementIds.has(sourceId)) {
        this._acceptedElementIds.add(sourceId);
        this._acceptedModelIds.add(hit.modelId!);
        if (hit.subCategoryId)
          this._acceptedSubCategoryIds.add(hit.subCategoryId);
        this.applyMask(vp);
      }
    }
    this.setupAndPromptForNextAction();
    return EventHandled.No;
  }

  protected createSubCategoryMask() {
    return PlanarClipMaskSettings.create({
      subCategoryIds: this._acceptedSubCategoryIds,
      modelIds: this._acceptedModelIds,
      transparency: this._transparency,
      invert: this._invert,
    });
  }

  protected createElementMask(option: "include" | "exclude") {
    return PlanarClipMaskSettings.create({
      elementIds: this._acceptedElementIds,
      exclude: "exclude" === option,
      modelIds: this._acceptedModelIds,
      transparency: this._transparency,
      invert: this._invert,
    });
  }

  protected createModelMask() {
    return PlanarClipMaskSettings.create({ modelIds: this._acceptedModelIds, transparency: this._transparency, invert: this._invert });
  }

  protected setRealityModelMask(vp: ScreenViewport, mask: PlanarClipMaskSettings): void {
    if (typeof this._targetMaskModel === "string")
      vp.displayStyle.settings.planarClipMasks.set(this._targetMaskModel, mask);
    else if (undefined !== this._targetMaskModel)
      this._targetMaskModel.planarClipMaskSettings = mask;
  }
}
/** Tool to mask background map by elements
 * @beta
 */
export class MaskBackgroundMapByElementTool extends PlanarMaskBaseTool {
  public static override toolId = "MaskBackgroundMapByElement";
  public static override get minArgs() { return 0; }
  public static override get maxArgs() { return 2; }
  protected override targetModelRequired() { return false; }
  protected showPrompt(): void {
    IModelApp.notifications.outputPromptByKey(`FrontendDevTools:tools.MaskBackgroundMapByElement.Prompts.${this._useSelection ? "AcceptSelection" : "IdentifyMaskElement"}`);
  }
  protected createToolInstance(): PlanarMaskBaseTool { return new MaskBackgroundMapByElementTool(); }
  protected applyMask(vp: ScreenViewport): void {
    vp.changeBackgroundMapProps({ planarClipMask: this.createElementMask("include").toJSON() });
  }
}
/** Tool to mask background map by excluded elements
 * @beta
 */
export class MaskBackgroundMapByExcludedElementTool extends PlanarMaskBaseTool {
  public static override toolId = "MaskBackgroundMapByExcludedElement";
  public static override get minArgs() { return 0; }
  public static override get maxArgs() { return 2; }
  protected override targetModelRequired() { return false; }
  protected showPrompt(): void {
    IModelApp.notifications.outputPromptByKey(`FrontendDevTools:tools.MaskBackgroundMapByExcludedElement.Prompts.${this._useSelection ? "AcceptSelection" : "IdentifyMaskElement"}`);
  }
  protected createToolInstance(): PlanarMaskBaseTool { return new MaskBackgroundMapByExcludedElementTool(); }
  protected applyMask(vp: ScreenViewport): void {
    vp.changeBackgroundMapProps({ planarClipMask: this.createElementMask("exclude").toJSON() });
  }
}

/** Tool to mask background map by SubCategories
 * @beta
 */
export class MaskBackgroundMapBySubCategoryTool extends PlanarMaskBaseTool {
  public static override toolId = "MaskBackgroundMapBySubCategory";
  public static override get minArgs() { return 0; }
  public static override get maxArgs() { return 2; }
  protected override targetModelRequired() { return false; }
  protected override allowSelection(): boolean { return false; }   // Need picking to get subcategory.
  protected showPrompt(): void {
    IModelApp.notifications.outputPromptByKey("FrontendDevTools:tools.MaskBackgroundMapBySubCategory.Prompts.IdentifyMaskSubCategory");
  }
  protected createToolInstance(): PlanarMaskBaseTool { return new MaskBackgroundMapBySubCategoryTool(); }
  protected applyMask(vp: ScreenViewport): void {
    vp.changeBackgroundMapProps({ planarClipMask: this.createSubCategoryMask().toJSON() });
  }
}

/** Tool to mask background map by geometric models
 * @beta
 */
export class MaskBackgroundMapByModelTool extends PlanarMaskBaseTool {
  public static override toolId = "MaskBackgroundMapByModel";
  public static override get minArgs() { return 0; }
  public static override get maxArgs() { return 2; }
  protected override targetModelRequired() { return false; }
  protected showPrompt(): void {
    IModelApp.notifications.outputPromptByKey(`FrontendDevTools:tools.MaskBackgroundMapByModel.Prompts.${this._useSelection ? "AcceptSelection" : "IdentifyMaskModel"}`);
  }
  protected createToolInstance(): PlanarMaskBaseTool { return new MaskBackgroundMapByModelTool(); }
  protected applyMask(vp: ScreenViewport): void {
    vp.changeBackgroundMapProps({ planarClipMask: this.createModelMask().toJSON() });
  }
}

/** Tool to mask reality model by elements
 * @beta
 */
export class MaskRealityModelByElementTool extends PlanarMaskBaseTool {
  public static override toolId = "MaskRealityModelByElement";
  public static override get minArgs() { return 0; }
  public static override get maxArgs() { return 2; }
  protected override targetModelRequired() { return true; }

  protected showPrompt(): void {
    const key = `FrontendDevTools:tools.MaskRealityModelByElement.Prompts.${this._targetMaskModel === undefined ? "IdentifyRealityModel" : (this._useSelection ? "AcceptSelection" : "IdentifyMaskElement")}`;
    IModelApp.notifications.outputPromptByKey(key);
  }
  protected createToolInstance(): PlanarMaskBaseTool { return new MaskRealityModelByElementTool(); }
  protected applyMask(vp: ScreenViewport): void {
    this.setRealityModelMask(vp, this.createElementMask("include"));
  }
}

/** Tool to mask reality model by excluded elements
 * @beta
 */
export class MaskRealityModelByExcludedElementTool extends PlanarMaskBaseTool {
  public static override toolId = "MaskRealityModelByExcludedElement";
  public static override get minArgs() { return 0; }
  public static override get maxArgs() { return 2; }
  protected override targetModelRequired() { return true; }

  protected showPrompt(): void {
    const key = `FrontendDevTools:tools.MaskRealityModelByExcludedElement.Prompts.${this._targetMaskModel === undefined ? "IdentifyRealityModel" : (this._useSelection ? "AcceptSelection" : "IdentifyMaskElement")}`;
    IModelApp.notifications.outputPromptByKey(key);
  }
  protected createToolInstance(): PlanarMaskBaseTool { return new MaskRealityModelByExcludedElementTool(); }
  protected applyMask(vp: ScreenViewport): void {
    this.setRealityModelMask(vp, this.createElementMask("exclude"));
  }
}

/** Tool to mask reality model by geometric models
 * @beta
 */

export class MaskRealityModelByModelTool extends PlanarMaskBaseTool {
  public static override toolId = "MaskRealityModelByModel";
  public static override get minArgs() { return 0; }
  public static override get maxArgs() { return 2; }

  protected override targetModelRequired() { return true; }

  protected showPrompt(): void {
    const key = `FrontendDevTools:tools.MaskRealityModelByModel.Prompts.${this._targetMaskModel === undefined ? "IdentifyRealityModel" : (this._useSelection ? "AcceptSelection" : "IdentifyMaskModel")}`;
    IModelApp.notifications.outputPromptByKey(key);
  }
  protected createToolInstance(): PlanarMaskBaseTool { return new MaskRealityModelByModelTool(); }
  protected applyMask(vp: ScreenViewport): void {
    this.setRealityModelMask(vp, this.createModelMask());
  }
}

/** Tool to mask reality model by SubCategories
 * @beta
 */
export class MaskRealityModelBySubCategoryTool extends PlanarMaskBaseTool {
  public static override toolId = "MaskRealityModelBySubCategory";
  public static override get minArgs() { return 0; }
  public static override get maxArgs() { return 2; }
  protected override targetModelRequired() { return true; }
  protected override allowSelection(): boolean { return false; }   // Need picking to get subcategory.

  protected showPrompt(): void {
    const key = `FrontendDevTools:tools.MaskRealityModelByModel.Prompts.${this._targetMaskModel === undefined ? "IdentifyRealityModel" : "IdentifyMaskSubCategory"}`;
    IModelApp.notifications.outputPromptByKey(key);
  }
  protected createToolInstance(): PlanarMaskBaseTool { return new MaskRealityModelBySubCategoryTool(); }
  protected applyMask(vp: ScreenViewport): void {
    this.setRealityModelMask(vp, this.createSubCategoryMask());
  }
}

/** Tool to mask reality model by higher priority models.
 * @beta
 */
export class SetHigherPriorityRealityModelMasking extends PlanarMaskBaseTool {
  public static override toolId = "SetHigherPriorityRealityModelMasking";
  public static override get minArgs() { return 0; }
  public static override get maxArgs() { return 3; }
  protected override targetModelRequired() { return true; }
  protected override elementRequired() { return false; }
  private _priority = 0;

  protected showPrompt(): void {
    IModelApp.notifications.outputPromptByKey("FrontendDevTools:tools.SetHigherPriorityRealityModelMasking.Prompts.IdentifyRealityModel");
  }
  protected createToolInstance(): PlanarMaskBaseTool { return new SetHigherPriorityRealityModelMasking(); }
  protected applyMask(vp: ScreenViewport): void {
    const basePriority = this._targetMaskModel === vp.displayStyle.getOSMBuildingRealityModel() ? PlanarClipMaskPriority.GlobalRealityModel : PlanarClipMaskPriority.RealityModel;
    this.setRealityModelMask(vp, PlanarClipMaskSettings.create({ priority: basePriority + this._priority, transparency: this._transparency, invert: this._invert }));
  }

  public override async parseAndRun(...args: string[]): Promise<boolean> {
    await super.parseAndRun(...args);
    const priority = parseInt(args[0], 10);
    this._priority = (priority === undefined || isNaN(priority)) ? 0 : priority;
    if (args.length > 1) {
      const value = parseInt(args[1], 10);
      if (!isNaN(value) && value >= 0 && value <= 1)
        this._transparency = value;
    }
    if (args.length > 2)
      this._invert = parseBoolean(args[2]) === true;

    return this.run();
  }
}

/** Remove masks from reality model.
 * @beta
 */
export class UnmaskRealityModelTool extends PlanarMaskBaseTool {
  public static override toolId = "UnmaskRealityModel";
  protected override targetModelRequired() { return true; }

  protected showPrompt(): void {
    IModelApp.notifications.outputPromptByKey("FrontendDevTools:tools.UnmaskRealityModel.Prompts.IdentifyRealityModel");
  }
  protected createToolInstance(): PlanarMaskBaseTool { return new UnmaskRealityModelTool(); }
  protected applyMask(vp: ScreenViewport): void {
    const settings = PlanarClipMaskSettings.create({ subCategoryIds: this._acceptedSubCategoryIds, modelIds: this._acceptedModelIds });
    this.setRealityModelMask(vp, settings);
  }
  public override async onDataButtonDown(ev: BeButtonEvent): Promise<EventHandled> {
    const hit = await IModelApp.locateManager.doLocate(new LocateResponse(), true, ev.point, ev.viewport, ev.inputSource);
    if (hit?.modelId) {
      const model = hit.viewport.displayStyle.contextRealityModelStates.find((x) => x.modelId === hit.modelId);
      if (model)
        model.planarClipMaskSettings = undefined;
      else
        hit.viewport.displayStyle.settings.planarClipMasks.delete(hit.modelId);

      await this.onRestartTool();
    }

    return EventHandled.No;
  }
}
