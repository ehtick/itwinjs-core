/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/

import { RealityDataAccessClient, RealityDataClientOptions } from "@itwin/reality-data-client";
import {
  assert, Dictionary, Id64, Id64Array, Id64String, ProcessDetector, SortedArray, StopWatch,
} from "@itwin/core-bentley";
import {
  BackgroundMapType, BaseMapLayerSettings, DisplayStyleProps, FeatureAppearance, Hilite, RenderMode, ViewStateProps,
} from "@itwin/core-common";
import {
  CheckpointConnection,
  DisplayStyle3dState, DisplayStyleState, EntityState, FeatureSymbology, GLTimerResult, IModelApp, IModelConnection,
  ModelDisplayTransform,
  ModelDisplayTransformProvider,
  PerformanceMetrics, Pixel, RenderMemory, RenderSystem, ScreenViewport, Target, TileAdmin, ToolAdmin, ViewRect, ViewState,
} from "@itwin/core-frontend";
import { HyperModeling } from "@itwin/hypermodeling-frontend";
import { TestFrontendAuthorizationClient } from "@itwin/oidc-signin-tool/lib/cjs/TestFrontendAuthorizationClient";
import DisplayPerfRpcInterface from "../common/DisplayPerfRpcInterface";
import { DisplayPerfTestApp } from "./DisplayPerformanceTestApp";
import {
  defaultEmphasis, defaultHilite, DisplayTransformProviderProps, ElementOverrideProps, HyperModelingProps, separator, TestConfig, TestConfigProps, TestConfigStack, ViewStateSpec, ViewStateSpecProps,
} from "./TestConfig";
import { SavedViewsFetcher } from "./SavedViewsFetcher";
import { Transform } from "@itwin/core-geometry";
import { TestSnapshotConnection } from "./TestSnapshotConnection";

/** JSON representation of a set of tests. Each test in the set inherits the test set's configuration. */
export interface TestSetProps extends TestConfigProps {
  tests: TestConfigProps[];
  reuseContext: boolean;
}

/** JSON representation of TestRunner. The tests inherit the base configuration options. */
export interface TestSetsProps extends TestConfigProps {
  signIn?: boolean;
  minimize?: boolean;
  renderCmdStats?: boolean;
  testSet: TestSetProps[];
}

/** Context for any number of TestCases to be run against an iModel. */
interface TestContext {
  readonly iModel: IModelConnection;
  readonly externalSavedViews: ViewStateSpec[];
  readonly iModelKey: string;
}

/** The view against which a specific TestCase is to be run. */
interface TestViewState {
  readonly view: ViewState;
  readonly elementOverrides?: ElementOverrideProps[];
  readonly selectedElements?: Id64String | Id64Array;
}

/** The result of TestRunner.runTest. */
interface TestResult {
  /** An ordered listing of all the tiles selected for display. */
  selectedTileIds: string;
  /** The number of tiles selected for display. */
  numSelectedTiles: number;
  /** Approximate time in milliseconds before all tiles were ready for display. */
  tileLoadingTime: number;
  /** The total number of milliseconds spent decoding content. */
  tileDecodingTime: number;
  /** Amount of memory requested from the GPU for the graphics of the tiles selected for display. */
  selectedTileGpuBytes: number;
  /** Amount of memory requested from the GPU for the graphics of all tiles in the tile trees viewed by this test.
   * This is always at least as large as selectedTileGpuBytes and may be much larger as recently-used tiles are kept in memory
   * for a period of time, and parent tiles' graphics are typically kept in memory for as long as their child tiles are.
   * Therefore this may be expected to grow over time as successive tests exercise different views of the same tile trees.
   */
  viewedTileTreeGpuBytes: number;
  /** Total amount of memory requested (and not yet relinquished) from the GPU by the render system, including frame buffers,
   * textures, graphics, etc.
   */
  totalGpuBytes: number;
}

/** A test being executed in a viewport. */
interface TestCase extends TestResult {
  readonly viewport: ScreenViewport;
  view: TestViewState;
}

/** Timings collected during TestRunner.runTest. */
class Timings {
  public readonly cpu = new Array<Map<string, number>>();
  public readonly gpu = new Map<string, number[]>();
  public readonly actualFps = new Array<Map<string, number>>();
  public gpuFramesCollected = 0;
  public readonly callback: (result: GLTimerResult) => void;

  public constructor(numFramesToCollect: number) {
    this.callback = (result: GLTimerResult) => {
      if (this.gpuFramesCollected >= numFramesToCollect)
        return;

      const label = result.label;
      const timings = this.gpu.get(label);
      this.gpu.set(label, timings ? timings.concat(result.nanoseconds / 1e6) : [result.nanoseconds / 1e6]); // save as milliseconds
      if (result.children)
        for (const child of result.children)
          this.callback(child);

      if ("Total" === label)
        ++this.gpuFramesCollected;
    };
  }

  public set callbackEnabled(enabled: boolean) {
    IModelApp.renderSystem.debugControl!.resultsCallback = enabled ? this.callback : undefined;
  }
}

/** Applies ELementOverrideProps to elements in a viewport for a TestCase. */
class OverrideProvider {
  private readonly _elementOvrs = new Map<Id64String, FeatureAppearance>();
  private readonly _defaultOvrs?: FeatureAppearance;

  private constructor(ovrs: ElementOverrideProps[]) {
    for (const ovr of ovrs) {
      const app = FeatureAppearance.fromJSON(JSON.parse(ovr.fsa));
      if (ovr.id === "-default-")
        this._defaultOvrs = app;
      else
        this._elementOvrs.set(ovr.id, app);
    }
  }

  public static override(vp: ScreenViewport, ovrs: ElementOverrideProps[]): void {
    const provider = new OverrideProvider(ovrs);
    vp.addFeatureOverrideProvider(provider);
  }

  public addFeatureOverrides(ovrs: FeatureSymbology.Overrides): void {
    if (this._defaultOvrs)
      ovrs.setDefaultOverrides(this._defaultOvrs);

    for (const [elementId, appearance] of this._elementOvrs)
      ovrs.override({ elementId, appearance });
  }
}

class DisplayTransformProvider implements ModelDisplayTransformProvider {
  private readonly _transforms = new Map<string, ModelDisplayTransform>();
  private constructor() { }

  public static fromJSON(props: DisplayTransformProviderProps): DisplayTransformProvider {
    const provider = new DisplayTransformProvider();
    for (const prop of props) {
      provider._transforms.set(prop.modelId, { transform: Transform.fromJSON(prop.transform), premultiply: prop.premultiply });
    }

    return provider;
  }

  public getModelDisplayTransform(modelId: string): ModelDisplayTransform | undefined {
    return this._transforms.get(modelId);
  }
}

/** Given the JSON representation of a set of tests, executes them and records output (CSV timing info, images, logs, etc). */
export class TestRunner {
  private readonly _config: TestConfigStack;
  private readonly _minimizeOutput: boolean;
  private readonly _outputRenderCmdStats: boolean;
  private readonly _testSets: TestSetProps[];
  private readonly _logFileName: string;
  private readonly _testNamesImages = new Map<string, number>();
  private readonly _testNamesTimings = new Map<string, number>();
  private readonly _savedViewsFetcher: SavedViewsFetcher;
  private _lastRestartConfig: TestConfig;

  public get curConfig(): TestConfig {
    return this._config.top;
  }

  public get lastRestartConfig(): TestConfig { return this._lastRestartConfig; }
  public set lastRestartConfig(config: TestConfig) {
    this._lastRestartConfig = config;
  }

  public constructor(
    props: TestSetsProps,
    savedViewsFetcher: SavedViewsFetcher = new SavedViewsFetcher(),
  ) {
    // NB: The default minimum spatial chord tolerance was changed from "no minimum" to 1mm. To preserve prior behavior,
    // override it to zero.
    // Subsequently pushed configs can override this if desired.
    const defaultTileProps: TileAdmin.Props = { minimumSpatialTolerance: 0 };
    props.tileProps = props.tileProps ? { ...defaultTileProps, ...props.tileProps } : defaultTileProps;

    this._config = new TestConfigStack(new TestConfig(props));
    this._lastRestartConfig = this.curConfig;
    this._testSets = props.testSet;
    this._minimizeOutput = true === props.minimize;
    this._outputRenderCmdStats = true === props.renderCmdStats;
    this._logFileName = "_DispPerfTestAppViewLog.txt";
    this._savedViewsFetcher = savedViewsFetcher;

    ToolAdmin.exceptionHandler = async (ex) => this.onException(ex);
  }

  /** Run all the tests. */
  public async run(): Promise<void> {
    const msg = `View Log,  Model Base Location: ${this.curConfig.iModelLocation}\n  format: Time_started  ModelName  [ViewName]`;
    await this.logToConsole(msg);
    await this.logToFile(msg, { noAppend: true });

    let needRestart = this.curConfig.requiresRestart(new TestConfig({})); // If current config differs from default, restart
    const renderOptions: RenderSystem.Options = this.curConfig.renderOptions ?? {};
    if (!this.curConfig.useDisjointTimer) {
      const ext = this.curConfig.renderOptions?.disabledExtensions;
      renderOptions.disabledExtensions = Array.isArray(ext) ? ext.concat(["EXT_disjoint_timer_query", "EXT_disjoint_timer_query_webgl2"]) : ["EXT_disjoint_timer_query", "EXT_disjoint_timer_query_webgl2"];
      needRestart = true;
    }
    if (IModelApp.initialized && needRestart) {
      await IModelApp.shutdown();
    }
    if (!IModelApp.initialized) {
      const realityDataClientOptions: RealityDataClientOptions = {
        /** API Version. v1 by default */
        // version?: ApiVersion;
        /** API Url. Used to select environment. Defaults to "https://api.bentley.com/reality-management/reality-data" */
        baseUrl: `https://${process.env.IMJS_URL_PREFIX ?? ""}api.bentley.com`,
      };
      await DisplayPerfTestApp.startup({
        renderSys: renderOptions,
        tileAdmin: this.curConfig.tileProps,
        realityDataAccess: new RealityDataAccessClient(realityDataClientOptions),
      });
    }
    // save current state as reference, whether or not we restarted
    this.lastRestartConfig = this.curConfig;

    // Run all the tests
    for (const set of this._testSets)
      await this.runTestSet(set);

    // Update UI to signal we're finished.
    const topdiv = document.getElementById("topdiv")!;
    topdiv.style.display = "block";
    topdiv.innerText = "Tests Completed.";
    document.getElementById("imodel-viewport")!.style.display = "hidden";

    // Write WebGL compatibility info to CSV.
    await this.finish();
  }

  private async runTestSet(set: TestSetProps): Promise<void> {
    this._config.push(set);
    const realityDataClientOptions: RealityDataClientOptions = {
      /** API Version. v1 by default */
      // version?: ApiVersion;
      /** API Url. Used to select environment. Defaults to "https://api.bentley.com/realitydata" */
      baseUrl: `https://${process.env.IMJS_URL_PREFIX ?? ""}api.bentley.com`,
    };

    let context: TestContext | undefined;

    // Perform all the tests for this iModel. If the iModel name contains an asterisk,
    // treat it as a wildcard and run tests for each iModel that matches the given wildcard.
    for (const testProps of set.tests) {
      this._config.push(testProps);

      // Ensure IModelApp is initialized with options required by this test.
      if (IModelApp.initialized && this.curConfig.requiresRestart(this.lastRestartConfig)) {
        context = undefined;
        await IModelApp.shutdown();
      }
      if (!IModelApp.initialized) {
        const renderOptions: RenderSystem.Options = this.curConfig.renderOptions ?? {};
        if (!this.curConfig.useDisjointTimer) {
          const ext = this.curConfig.renderOptions?.disabledExtensions;
          renderOptions.disabledExtensions = Array.isArray(ext) ? ext.concat(["EXT_disjoint_timer_query", "EXT_disjoint_timer_query_webgl2"]) : ["EXT_disjoint_timer_query", "EXT_disjoint_timer_query_webgl2"];
        }
        await DisplayPerfTestApp.startup({
          renderSys: renderOptions,
          tileAdmin: this.curConfig.tileProps,
          realityDataAccess: new RealityDataAccessClient(realityDataClientOptions),
        });
        this.lastRestartConfig = this.curConfig;
      }

      // Run test against all iModels matching the test config.
      const iModelNames = await this.getIModelNames();
      const originalViewName = this.curConfig.viewName;

      for (const iModelName of iModelNames) {
        this.curConfig.iModelName = iModelName;
        this.curConfig.viewName = originalViewName;
        const iModelKey = this.curConfig.iModelId ? this.curConfig.iModelId : `${this.curConfig.iModelLocation}${separator}${this.curConfig.iModelName}`;

        try {
          const reuseContext = context && set.reuseContext && context.iModelKey === iModelKey;
          if (!reuseContext) {
            if (context) {
              await context?.iModel.close();
            }
            context = await this.openIModel();
          } else {
            context?.iModel.selectionSet.emptyAll();
          }
        } catch (e: any) {
          await this.logError(`Failed to open iModel ${iModelName}: ${(e as Error).message}`);
          continue;
        }

        try {
          if (context) {
            await this.runTests(context);
          } else {
            await this.logError(`Invalid test context on iModel ${iModelName}`);
          }
        } catch {
          await this.logError(`Failed to run tests on iModel ${iModelName}`);
        }
      }
      this._config.pop();
    }

    await context?.iModel.close();
    this._config.pop();
  }

  private async runTests(context: TestContext): Promise<void> {
    const viewNames = await this.getViewNames(context);
    for (const viewName of viewNames) {
      this.curConfig.viewName = viewName;

      await this.logTest();

      try {
        this.curConfig.urlStr = undefined;
        const result = await this.runTest(context);
        if (this.curConfig.urlStr)
          await this.logURL();
        if (result)
          await this.logToFile(result.selectedTileIds, { noNewLine: true });
      } catch (ex) {
        await this.onException(ex);
      }
    }
  }

  private async runTest(context: TestContext): Promise<TestResult | undefined> {
    // Reset the title bar to include the current model and view name
    const testConfig = this.curConfig;
    document.title = "Display Performance Test App:  ".concat(testConfig.iModelName ?? "", "  [", testConfig.viewName ?? "", "]");

    const test = await this.setupTest(context);
    if (!test)
      return undefined;

    using vp = test.viewport;
    if (testConfig.testType === "image" || testConfig.testType === "both") {
      this.updateTestNames(test, undefined, true);

      const canvas = vp.readImageToCanvas({omitCanvasDecorations: false});
      await savePng(this.getImageName(test), canvas);

      if (testConfig.testType === "image")
        return test;
    }

    // Throw away the first N frames until the timings become more consistent.
    for (let i = 0; i < this.curConfig.numRendersToSkip; i++) {
      vp.requestRedraw();
      vp.renderFrame();
    }

    this.updateTestNames(test);
    await (testConfig.testType === "readPixels" ? this.recordReadPixels(test) : this.recordRender(test));

    return test;
  }

  private async recordReadPixels(test: TestCase): Promise<void> {
    const vp = test.viewport;
    const viewRect = new ViewRect(0, 0, this.curConfig.view.width, this.curConfig.view.height);
    const timings = new Timings(this.curConfig.numRendersToTime);

    const testReadPix = async (pixSelect: Pixel.Selector, pixSelectStr: string) => {
      // Collect CPU timings.
      setPerformanceMetrics(vp, new PerformanceMetrics(true, false, undefined));
      for (let i = 0; i < this.curConfig.numRendersToTime; ++i) {
        vp.readPixels(viewRect, pixSelect, () => { });
        timings.cpu[i] = (vp.target as Target).performanceMetrics!.frameTimings;
        timings.cpu[i].delete("Scene Time");
      }

      // Collect GPU timings.
      timings.gpuFramesCollected = 0;
      timings.callbackEnabled = true;
      setPerformanceMetrics(vp, new PerformanceMetrics(true, false, timings.callback));
      await this.renderAsync(vp, this.curConfig.numRendersToTime, timings);
      timings.callbackEnabled = false;

      this.updateTestNames(test, pixSelectStr, true);
      this.updateTestNames(test, pixSelectStr, false);

      const row = this.getRowData(timings, test, pixSelectStr);
      await this.saveCsv(row);
      await this.createReadPixelsImages(test, pixSelect, pixSelectStr);
    };

    // Test each combo of pixel selectors.
    await testReadPix(Pixel.Selector.Feature, "+feature");
    await testReadPix(Pixel.Selector.GeometryAndDistance, "+geom+dist");
    await testReadPix(Pixel.Selector.All, "+feature+geom+dist");
  }

  private async recordRender(test: TestCase): Promise<void> {
    const timings = new Timings(this.curConfig.numRendersToTime);
    setPerformanceMetrics(test.viewport, new PerformanceMetrics(true, false, timings.callback));
    await this.renderAsync(test.viewport, this.curConfig.numRendersToTime, timings);

    const row = this.getRowData(timings, test);
    await this.saveCsv(row);
  }

  private async renderAsync(vp: ScreenViewport, numFrames: number, timings: Timings): Promise<void> {
    IModelApp.viewManager.addViewport(vp);

    const target = vp.target as Target;
    const metrics = target.performanceMetrics;
    assert(undefined !== metrics);

    target.performanceMetrics = undefined;
    timings.callbackEnabled = false;

    const numFramesToIgnore = 120;
    let ignoreFrameCount = 0;
    let frameCount = 0;
    vp.continuousRendering = true;
    return new Promise((resolve: () => void, _reject) => {
      const timer = new StopWatch();
      const removeListener = vp.onRender.addListener(() => {
        // Ignore the first N frames - they seem to have more variable frame rate.
        if (++ignoreFrameCount <= numFramesToIgnore) {
          if (ignoreFrameCount === numFramesToIgnore) {
            // Time to start recording.
            target.performanceMetrics = metrics;
            timings.callbackEnabled = true;
            timer.start();
          }

          return;
        }

        timer.stop();
        timings.actualFps[frameCount] = metrics.frameTimings;
        timings.actualFps[frameCount].set("Total Time", timer.current.milliseconds);

        if (++frameCount === numFrames)
          target.performanceMetrics = undefined;

        if (timings.gpuFramesCollected >= numFrames || (frameCount >= numFrames && !IModelApp.renderSystem.debugControl?.isGLTimerSupported)) {
          removeListener();
          IModelApp.viewManager.dropViewport(vp, false);
          vp.continuousRendering = false;
          timings.callbackEnabled = false;
          resolve();
        } else {
          vp.requestRedraw();
          timer.start();
        }
      });
    });
  }

  private async setupTest(context: TestContext): Promise<TestCase | undefined> {
    const imodel = context.iModel;
    // Open the view.
    const view = await this.loadView(context);
    if (!view)
      return undefined;

    const viewport = this.openViewport(view.view);

    // Apply hypermodeling
    const hyperModeling = this.curConfig.hyperModeling;
    if (hyperModeling) {
      try {
        const decorator = await HyperModeling.start(viewport);
        const marker = decorator?.markers.findMarkerById(hyperModeling.sectionDrawingLocationId);
        if (!decorator) {
          await this.logError("Failed to start hypermodeling.");
        } else if (!marker) {
          await this.logError(`SectionDrawingLocation ${hyperModeling.sectionDrawingLocationId} not found.`);
        } else {
          if (hyperModeling.applySpatialView) {
            await decorator.toggleSection(marker, true);
          } else {
            decorator.toggleClipVolume(marker, true);
            await decorator.toggleAttachment(marker, true);
          }
        }
      } catch (err: any) {
        await DisplayPerfTestApp.logException(err, { dir: this.curConfig.outputPath, name: this._logFileName });
      }
    }

    // Apply emphasis and hilite settings.
    const config = this.curConfig;
    if (config.hilite)
      viewport.hilite = config.hilite;

    if (config.emphasis)
      viewport.emphasisSettings = config.emphasis;

    // Apply display style.
    if (config.displayStyle) {
      const styleProps = await imodel.elements.queryProps({ from: DisplayStyleState.classFullName, where: `CodeValue='${config.displayStyle}'` });
      if (styleProps.length >= 1) {
        const style = new DisplayStyle3dState(styleProps[0] as DisplayStyleProps, imodel);
        await style.load();
        viewport.view.setDisplayStyle(style);
      }
    }

    // Apply the view flags.
    if (config.viewFlags) {
      const vf = viewport.viewFlags as { [key: string]: any };
      const configVf = config.viewFlags as { [key: string]: any };
      for (const key of Object.keys(vf)) {
        const flag = configVf[key];
        if (undefined !== flag) {
          if (key === "renderMode" && typeof flag === "string") {
            switch (flag.toLowerCase()) {
              case "solidfill":
                vf.renderMode = RenderMode.SolidFill;
                break;
              case "hiddenline":
                vf.renderMode = RenderMode.HiddenLine;
                break;
              case "wireframe":
                vf.renderMode = RenderMode.Wireframe;
                break;
              case "smoothshade":
                vf.renderMode = RenderMode.SmoothShade;
                break;
            }
          } else {
            vf[key] = flag;
          }
        } else {
          configVf[key] = vf[key];
        }
      }
    }

    if (config.backgroundMap)
      viewport.changeBackgroundMapProps(viewport.displayStyle.settings.backgroundMap.clone(config.backgroundMap).toJSON());

    // Apply symbology overrides
    if (view.elementOverrides)
      OverrideProvider.override(viewport, view.elementOverrides);

    // Ensure all tiles required for the view are loaded.
    const result = await this.waitForTilesToLoad(viewport);

    // Set selected elements after all tiles have loaded.
    if (view.selectedElements) {
      imodel.selectionSet.add(view.selectedElements);
      viewport.markSelectionSetDirty();
      viewport.renderFrame();
    }

    return { ...result, viewport, view };
  }

  private async waitForTilesToLoad(viewport: ScreenViewport): Promise<TestResult> {
    const timer = new StopWatch(undefined, true);
    await viewport.waitForSceneCompletion();
    timer.stop();

    const decodingTime = IModelApp.tileAdmin.statistics.decoding.total;
    IModelApp.tileAdmin.resetStatistics();

    const selectedTiles = getSelectedTileStats(viewport);
    return {
      tileDecodingTime: decodingTime,
      tileLoadingTime: timer.current.milliseconds,
      selectedTileIds: selectedTiles.ids,
      numSelectedTiles: selectedTiles.count,
      selectedTileGpuBytes: selectedTiles.gpuBytes,
      viewedTileTreeGpuBytes: calcGpuBytes((stats) => viewport.collectStatistics(stats)),
      totalGpuBytes: calcGpuBytes((stats) => {
        viewport.target.renderSystem.collectStatistics(stats);
        viewport.target.collectStatistics(stats);
        viewport.iModel.tiles.forEachTreeOwner((owner) => owner.tileTree?.collectStatistics(stats));
      }),
    };
  }

  private openViewport(view: ViewState): ScreenViewport {
    // Ensure the exact same number of pixels regardless of device pixel ratio.
    const div = document.getElementById("imodel-viewport") as HTMLDivElement;
    const ratio = false === IModelApp.renderSystem.options.dpiAwareViewports ? 1 : (window.devicePixelRatio || 1);
    const width = `${String(this.curConfig.view.width / ratio)}px`;
    const height = `${String(this.curConfig.view.height / ratio)}px`;

    div.style.width = width;
    div.style.height = height;

    const vp = ScreenViewport.create(div, view);
    vp.rendersToScreen = true;

    vp.canvas.style.width = width;
    vp.canvas.style.height = height;

    return vp;
  }

  private async loadViewFromSpec(spec: ViewStateSpec, context: TestContext): Promise<TestViewState | undefined> {
    const className = spec.viewProps.viewDefinitionProps.classFullName;
    const ctor = await context.iModel.findClassFor<typeof EntityState>(className, undefined) as typeof ViewState | undefined;
    const view = ctor?.createFromProps(spec.viewProps, context.iModel);
    if (!view) {
      await this.logError("Failed to create view from spec");
      return undefined;
    }

    await view.load();

    view.modelDisplayTransformProvider = spec.displayTransformProvider;
    return {
      view,
      elementOverrides: spec.elementOverrides,
      selectedElements: spec.selectedElements,
    };
  }

  private async loadView(context: TestContext): Promise<TestViewState | undefined> {
    // If viewStateSpec is defined, use it. If we fail to instantiate it, fail.
    const config = this.curConfig;
    if (config.viewStateSpec)
      return this.loadViewFromSpec(config.viewStateSpec, context);

    // If extViewName defined, find the matching external view. If none found, fail.
    if (config.extViewName) {
      const spec = context.externalSavedViews.find((x) => x.name === config.extViewName);
      if (spec)
        return this.loadViewFromSpec(spec, context);

      await this.logError(`Failed to find external saved view ${config.extViewName}`);
      return undefined;
    }

    // If viewName is defined, find a persistent view with that name.
    const ids = await context.iModel.elements.queryIds({ from: ViewState.classFullName, where: `CodeValue='${config.viewName}'` });
    for (const id of ids)
      return { view: await context.iModel.views.load(id) };

    // Try to find an external view matching viewName.
    const extSpec = context.externalSavedViews.find((x) => x.name === config.viewName);
    if (extSpec)
      return this.loadViewFromSpec(extSpec, context);

    await this.logError(`Failed to find persistent view ${config.viewName}`);
    return undefined;
  }

  private updateTestNames(test: TestCase, prefix?: string, isImage = false): void {
    const testNames = isImage ? this._testNamesImages : this._testNamesTimings;
    const testName = this.getTestName(test, prefix, false, true);
    const testNameDupes = testNames.get(testName) ?? 0;
    testNames.set(testName, testNameDupes + 1);
  }

  private async logTest(): Promise<void> {
    const testConfig = this.curConfig;
    const today = new Date();
    const month = (`0${(today.getMonth() + 1)}`).slice(-2);
    const day = (`0${today.getDate()}`).slice(-2);
    const year = today.getFullYear();
    const hours = (`0${today.getHours()}`).slice(-2);
    const minutes = (`0${today.getMinutes()}`).slice(-2);
    const seconds = (`0${today.getSeconds()}`).slice(-2);
    const outStr = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}  ${testConfig.iModelName}  [${testConfig.viewName}]`;

    await this.logToConsole(outStr);
    return this.logToFile(outStr);
  }

  // Log url path for cases it is used
  private async logURL(): Promise<void> {
    const outStr = `  [url: ${this.curConfig.urlStr}]`;
    await this.logToConsole(outStr);
    return this.logToFile(outStr);
  }

  private async openIModel(): Promise<TestContext> {
    if (this.curConfig.iModelId) {
      if (process.env.IMJS_OIDC_HEADLESS) {
        const token = await DisplayPerfRpcInterface.getClient().getAccessToken();
        IModelApp.authorizationClient = new TestFrontendAuthorizationClient(token);
      }
      // Download remote iModel and its saved views
      const { iModelId, iTwinId } = this.curConfig;
      if (iTwinId === undefined)
        throw new Error("Missing iTwinId for remote iModel");
      const iModel = await CheckpointConnection.openRemote(iTwinId, iModelId);
      const externalSavedViews = await this._savedViewsFetcher.getSavedViews(iTwinId, iModelId, await IModelApp.getAccessToken());
      return { iModel, externalSavedViews, iModelKey: this.curConfig.iModelId };
    } else {
      // Load local iModel and its saved views
      const filepath = `${this.curConfig.iModelLocation}${separator}${this.curConfig.iModelName}`;
      const iModel = await TestSnapshotConnection.openFile(filepath);

      const esv = await DisplayPerfRpcInterface.getClient().readExternalSavedViews(filepath);
      let externalSavedViews: ViewStateSpec[] = [];
      if (esv) {
        const json = JSON.parse(esv) as ViewStateSpecProps[];
        externalSavedViews = json.map((x) => {
          return {
            name: x._name,
            viewProps: JSON.parse(x._viewStatePropsString) as ViewStateProps,
            elementOverrides: x._overrideElements ? JSON.parse(x._overrideElements) as ElementOverrideProps[] : undefined,
            selectedElements: x._selectedElements ? JSON.parse(x._selectedElements) as Id64String | Id64Array : undefined,
            displayTransformProvider: x._displayTransforms ? DisplayTransformProvider.fromJSON(JSON.parse(x._displayTransforms)) : undefined,
          };
        });
      }
      return { iModel, externalSavedViews, iModelKey: filepath };
    }
  }

  private async getIModelNames(): Promise<string[]> {
    const config = this.curConfig;
    if (!config.iModelName.includes("*"))
      return [config.iModelName];

    const json = await DisplayPerfRpcInterface.getClient().getMatchingFiles(config.iModelLocation, config.iModelName);
    const files = JSON.parse(json);
    const iModels = [];
    for (const file of files) {
      if (file.endsWith(".bim") || file.endsWith(".ibim")) {
        const split = file.split(/[^\/\\]+/g);
        const iModel = split[split.length - 1];
        if (iModel)
          iModels.push(iModel);
      }
    }

    return iModels;
  }

  private async getViewNames(context: TestContext): Promise<string[]> {
    if (!this.curConfig.viewName.includes("*"))
      return [this.curConfig.viewName];

    let viewNames: string[] = [];
    if (this.curConfig.savedViewType !== "external") {
      const specs = await context.iModel.views.getViewList({ wantPrivate: true });
      viewNames = specs.map((spec) => spec.name);
    }

    if (this.curConfig.savedViewType !== "internal" && this.curConfig.savedViewType !== "local")
      viewNames = viewNames.concat(context.externalSavedViews.map((x) => x.name));

    return viewNames.filter((view) => matchRule(view, this.curConfig.viewName ?? "*")).sort();
  }

  private async finish(): Promise<void> {
    let renderData = "\"End of Tests-----------\r\n";
    const renderComp = IModelApp.queryRenderCompatibility();
    if (renderComp.userAgent) {
      renderData += `Browser: ${getBrowserName(renderComp.userAgent)}\r\n`;
      renderData += `User Agent: ${renderComp.userAgent}\r\n`;
    }
    if (renderComp.unmaskedRenderer)
      renderData += `Unmasked Renderer: ${renderComp.unmaskedRenderer}\r\n`;

    if (renderComp.unmaskedVendor)
      renderData += `Unmasked Vendor: ${renderComp.unmaskedVendor}\r\n`;

    if (renderComp.missingRequiredFeatures)
      renderData += `Missing Required Features: ${renderComp.missingRequiredFeatures}\r\n`;

    if (renderComp.missingOptionalFeatures)
      renderData += `Missing Optional Features: ${renderComp.missingOptionalFeatures}"\r\n`;

    await DisplayPerfRpcInterface.getClient().finishCsv(renderData, this.curConfig.outputPath, this.curConfig.outputName, this.curConfig.csvFormat);
    await this.logToConsole("Tests complete. Press Ctrl-C to exit.");
  }

  private async saveCsv(row: Map<string, number | string>): Promise<void> {
    const outputPath = this.curConfig.outputPath;
    const outputName = this.curConfig.outputName;
    const msg = JSON.stringify([...row]);
    return DisplayPerfRpcInterface.getClient().saveCsv(outputPath, outputName, msg, this.curConfig.csvFormat);
  }

  private async logToFile(message: string, opts?: { noAppend?: boolean, noNewLine?: boolean }): Promise<void> {
    if (!opts?.noNewLine)
      message = `${message}\n`;

    const append = !opts?.noAppend;
    return DisplayPerfRpcInterface.getClient().writeExternalFile(this.curConfig.outputPath, this._logFileName, append, message);
  }

  private async logToConsole(message: string): Promise<void> {
    return DisplayPerfRpcInterface.getClient().consoleLog(message);
  }

  private async logError(message: string): Promise<void> {
    const msg = `ERROR: ${message}`;
    await this.logToConsole(msg);
    return this.logToFile(msg);
  }

  private getTestName(test: TestCase, prefix?: string, isImage = false, ignoreDupes = false): string {
    let testName = prefix ?? "";
    const configs = this.curConfig;

    testName += configs.iModelName.replace(/\.[^/.]+$/, "");
    testName += `_${configs.viewName}`;
    testName += configs.displayStyle ? `_${configs.displayStyle.trim()}` : "";
    testName = testName.replace(/[/\\?%*:|"<>]/g, "-");

    const renderMode = getRenderMode(test.viewport);
    if (renderMode)
      testName += `_${renderMode}`;

    const vf = getViewFlagsString(test);
    if (vf)
      testName += `_${vf}`;

    const renderOpts = getRenderOpts(configs.renderOptions);
    if (renderOpts)
      testName += `_${renderOpts}`;

    const tileProps = configs.tileProps ? getTileProps(configs.tileProps) : undefined;
    if (tileProps)
      testName += `_${tileProps}`;

    const map = getBackgroundMapProps(test.viewport);
    if (map)
      testName += `_${map}`;

    const hyper = getHyperModelingProps(configs.hyperModeling);
    if (hyper)
      testName += `_${hyper}`;

    const other = getOtherProps(test.viewport);
    if (other)
      testName += `_${other}`;

    testName = removeOptsFromString(testName, configs.filenameOptsToIgnore);
    if (!ignoreDupes) {
      let testNum = isImage ? this._testNamesImages.get(testName) : this._testNamesTimings.get(testName);
      if (testNum === undefined)
        testNum = 0;

      testName += (testNum > 1) ? (`---${testNum}`) : "";
    }

    return testName;
  }

  private getImageName(test: TestCase, prefix?: string): string {
    const filename = `${this.getTestName(test, prefix, true)}.png`;
    if (ProcessDetector.isMobileAppFrontend)
      return filename; // on mobile we use device's Documents path as determined by mobile backend
    return `${this.curConfig.outputPath}${separator}${filename}`;
  }

  private getRowData(timings: Timings, test: TestCase, pixSelectStr?: string): Map<string, number | string> {
    const fixed = 4;
    const configs = this.curConfig;
    const rowData = new Map<string, number | string>();

    rowData.set("iModel", configs.iModelName);
    rowData.set("View", configs.viewName);

    const w = test.viewport.cssPixelsToDevicePixels(configs.view.width);
    const h = test.viewport.cssPixelsToDevicePixels(configs.view.height);
    rowData.set("Screen Size", `${w}X${h}`);

    rowData.set("Skip & Time Renders", `${configs.numRendersToSkip} & ${configs.numRendersToTime}`);
    rowData.set("Display Style", test.viewport.displayStyle.name);
    rowData.set("Render Mode", getRenderMode(test.viewport));
    rowData.set("View Flags", getViewFlagsString(test) !== "" ? ` ${getViewFlagsString(test)}` : "");
    rowData.set("Render Options", getRenderOpts(configs.renderOptions) !== "" ? ` ${getRenderOpts(configs.renderOptions)}` : "");

    const tileProps = configs.tileProps ? getTileProps(configs.tileProps) : "";
    rowData.set("Tile Props", "" !== tileProps ? ` ${tileProps}` : "");
    rowData.set("Bkg Map Props", getBackgroundMapProps(test.viewport) !== "" ? ` ${getBackgroundMapProps(test.viewport)}` : "");
    rowData.set("HyperModeling", getHyperModelingProps(configs.hyperModeling) ?? "");

    const other = getOtherProps(test.viewport);
    if ("" !== other)
      rowData.set("Other Props", ` ${other}`);

    if (pixSelectStr)
      rowData.set("ReadPixels Selector", ` ${pixSelectStr}`);

    rowData.set("Test Name", this.getTestName(test));
    rowData.set("Browser", getBrowserName(IModelApp.queryRenderCompatibility().userAgent));
    if (!this._minimizeOutput) {
      rowData.set("Tile Decoding Time", test.tileDecodingTime);
      rowData.set("Tile Loading Time", test.tileLoadingTime);
      rowData.set("Num Selected Tiles", test.numSelectedTiles);
      rowData.set("Selected Tile GPU MB", test.selectedTileGpuBytes / (1024 * 1024));
      rowData.set("Tile Tree GPU MB", test.viewedTileTreeGpuBytes / (1024 * 1024));
      rowData.set("Total GPU MB", test.totalGpuBytes / (1024 * 1024));
    }

    if (this._outputRenderCmdStats) {
      if (this._minimizeOutput) {
        rowData.set("Num Selected Tiles", test.numSelectedTiles);
        rowData.set("Selected Tile GPU MB", test.selectedTileGpuBytes / (1024 * 1024));
      }
      const dbgCtl = test.viewport.target.debugControl;
      if (undefined !== dbgCtl) {
        const cmdCounts = dbgCtl.getRenderCommands();
        let numPrimitives = 0;
        if (undefined !== cmdCounts) {
          for (const cc of cmdCounts) {
            rowData.set(cc.name, cc.count);
            if ("Primitives" === cc.name)
              numPrimitives = cc.count;
          }
          rowData.set("Primitives Per Tile", 0 === numPrimitives ? -1 : numPrimitives / test.numSelectedTiles);
        }
      }
    }

    const setGpuData = (name: string) => {
      if (name === "CPU Total Time")
        name = "Total";

      const gpuDataArray = timings.gpu.get(name);
      if (gpuDataArray) {
        let gpuSum = 0;
        for (const gpuData of gpuDataArray)
          gpuSum += gpuData;

        rowData.set(`GPU-${name}`, gpuDataArray.length ? (gpuSum / gpuDataArray.length).toFixed(fixed) : gpuSum.toFixed(fixed));
      }
    };

    // Calculate average timings
    if (pixSelectStr) { // timing read pixels
      for (const colName of timings.cpu[0].keys()) {
        let sum = 0;
        timings.cpu.forEach((timing) => {
          const data = timing.get(colName);
          sum += data ? data : 0;
        });

        if (!this._minimizeOutput || colName === "CPU Total Time") {
          rowData.set(colName, (sum / timings.cpu.length).toFixed(fixed));
          setGpuData(colName);
        }
      }
    } else { // timing render frame
      for (const colName of timings.actualFps[0].keys()) {
        let sum = 0;
        timings.actualFps.forEach((timing) => {
          const data = timing.get(colName);
          sum += data ? data : 0;
        });

        if (!this._minimizeOutput || colName === "CPU Total Time") {
          rowData.set(colName, sum / timings.actualFps.length);
          setGpuData(colName);
        }
      }
    }

    let totalTime: number;
    if (rowData.get("Finish GPU Queue")) { // If we can't collect GPU data, get non-interactive total time with 'Finish GPU Queue' time
      totalTime = Number(rowData.get("CPU Total Time")) + Number(rowData.get("Finish GPU Queue"));
      rowData.set("GPU Total Time", totalTime);
    }

    // Get these values from the timings.actualFps -- timings.actualFps === timings.cpu, unless in readPixels mode
    let totalRenderTime = 0;
    totalTime = 0;
    for (const time of timings.actualFps) {
      let timing = time.get("CPU Total Time");
      totalRenderTime += timing ? timing : 0;
      timing = time.get("Total Time");
      totalTime += timing ? timing : 0;
    }

    rowData.delete("Total Time");
    totalRenderTime /= timings.actualFps.length; // ie the CPU Total Time
    totalTime /= timings.actualFps.length;
    const disjointTimerUsed = rowData.get("GPU-Total") !== undefined;
    const totalGpuTime = Number(disjointTimerUsed ? rowData.get("GPU-Total") : rowData.get("GPU Total Time"));
    const gpuTolerance = disjointTimerUsed ? 2 : 3;
    const gpuBound = (totalGpuTime - totalRenderTime) > gpuTolerance;
    const cpuBound = disjointTimerUsed ? (((totalRenderTime - totalGpuTime) > gpuTolerance) && (totalRenderTime > 2)) : !gpuBound;
    let boundBy = "";
    if (totalRenderTime < 2 && !gpuBound) // ie total cpu time < 2ms && !gpuBound
      boundBy = "unmeasurable";
    else if (!gpuBound && !cpuBound)
      boundBy = "unknown";
    else if (gpuBound)
      boundBy = "gpu";
    else
      boundBy = "CPU";
    if ((1000.0 / totalTime) > 59) // ie actual fps > 60fps - 1fps tolerance
      boundBy += " (vsync)";
    const totalCpuTime = totalRenderTime > 2 ? totalRenderTime : 2; // add 2ms lower bound to cpu total time for tolerance
    const effectiveFps = 1000.0 / (gpuBound ? totalGpuTime : totalCpuTime);
    if (disjointTimerUsed) {
      rowData.set("GPU Total Time", totalGpuTime.toFixed(fixed));
      rowData.delete("GPU-Total");
    }
    rowData.set("Bound By", boundBy);
    rowData.set("Effective Total Time", gpuBound ? totalGpuTime.toFixed(fixed) : totalCpuTime.toFixed(fixed)); // This is the total gpu time if gpu bound or the total cpu time if cpu bound; times gather with running continuously
    rowData.set("Effective FPS", effectiveFps.toFixed(fixed));
    rowData.set("Actual Total Time", totalTime.toFixed(fixed));
    rowData.set("Actual FPS", totalTime > 0.0 ? (1000.0 / totalTime).toFixed(fixed) : "0");

    return rowData;
  }

  private async createReadPixelsImages(test: TestCase, pix: Pixel.Selector, pixStr: string): Promise<void> {
    const vp = test.viewport;
    const canvas = vp.readImageToCanvas({omitCanvasDecorations: false});
    const ctx = canvas.getContext("2d");
    if (!ctx)
      return;

    const cssRect = new ViewRect(0, 0, this.curConfig.view.width, this.curConfig.view.height);
    const imgWidth = vp.cssPixelsToDevicePixels(cssRect.width);
    const imgHeight = vp.cssPixelsToDevicePixels(cssRect.height);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const elemIdImgData = (pix & Pixel.Selector.Feature) ? ctx.createImageData(imgWidth, imgHeight) : undefined;
    const depthImgData = (pix & Pixel.Selector.GeometryAndDistance) ? ctx.createImageData(imgWidth, imgHeight) : undefined;
    const typeImgData = (pix & Pixel.Selector.GeometryAndDistance) ? ctx.createImageData(imgWidth, imgHeight) : undefined;

    vp.readPixels(cssRect, pix, (pixels) => {
      if (!pixels)
        return;

      for (let y = 0; y < imgHeight; ++y) {
        for (let x = 0; x < imgWidth; ++x) {
          const index = (x * 4) + (y * 4 * imgWidth);
          const pixel = pixels.getPixel(x, y);

          // RGB for element ID
          if (elemIdImgData !== undefined) {
            const elemId = Id64.getLowerUint32(pixel.elementId ? pixel.elementId : "");
            elemIdImgData.data[index + 0] = elemId % 256;
            elemIdImgData.data[index + 1] = (Math.floor(elemId / 256)) % 256;
            elemIdImgData.data[index + 2] = (Math.floor(elemId / (256 ^ 2))) % 256;
            elemIdImgData.data[index + 3] = 255; // Set alpha to 100% opaque
          }

          // RGB for Depth
          if (depthImgData !== undefined) {
            const distColor = pixels.getPixel(x, y).distanceFraction * 255;
            depthImgData.data[index + 0] = depthImgData.data[index + 1] = depthImgData.data[index + 2] = distColor;
            depthImgData.data[index + 3] = 255; // Set alpha to 100% opaque
          }

          // RGB for type
          if (typeImgData !== undefined) {
            const type = pixels.getPixel(x, y).type;
            switch (type) {
              case Pixel.GeometryType.None: // White
                typeImgData.data[index + 0] = 255;
                typeImgData.data[index + 1] = 255;
                typeImgData.data[index + 2] = 255;
                break;
              case Pixel.GeometryType.Surface: // Red
                typeImgData.data[index + 0] = 255;
                typeImgData.data[index + 1] = 0;
                typeImgData.data[index + 2] = 0;
                break;
              case Pixel.GeometryType.Linear: // Green
                typeImgData.data[index + 0] = 0;
                typeImgData.data[index + 1] = 255;
                typeImgData.data[index + 2] = 0;
                break;
              case Pixel.GeometryType.Edge: // Blue
                typeImgData.data[index + 0] = 0;
                typeImgData.data[index + 1] = 0;
                typeImgData.data[index + 2] = 255;
                break;
              case Pixel.GeometryType.Silhouette: // Purple
                typeImgData.data[index + 0] = 255;
                typeImgData.data[index + 1] = 0;
                typeImgData.data[index + 2] = 255;
                break;
              case Pixel.GeometryType.Unknown: // Black
              default:
                typeImgData.data[index + 0] = 0;
                typeImgData.data[index + 1] = 0;
                typeImgData.data[index + 2] = 0;
                break;
            }

            typeImgData.data[index + 3] = 255; // Set alpha to 100% opaque
          }
        }
      }
    });

    if (elemIdImgData !== undefined) {
      ctx.putImageData(elemIdImgData, 0, 0);
      await savePng(this.getImageName(test, `elemId_${pixStr}_`), canvas);
    }

    if (depthImgData !== undefined) {
      ctx.putImageData(depthImgData, 0, 0);
      await savePng(this.getImageName(test, `depth_${pixStr}_`), canvas);
    }

    if (typeImgData !== undefined) {
      ctx.putImageData(typeImgData, 0, 0);
      await savePng(this.getImageName(test, `type_${pixStr}_`), canvas);
    }
  }

  private async onException(ex: any): Promise<void> {
    // We need to log here so it gets written to the file.
    const terminateErr = await DisplayPerfTestApp.logException(ex, { dir: this.curConfig.outputPath, name: this._logFileName });
    if (terminateErr || "terminate" === this.curConfig.onException)
      await DisplayPerfRpcInterface.getClient().terminate();
  }
}

function removeOptsFromString(input: string, ignore: string[] | string | undefined): string {
  if (!ignore)
    return input;

  let output = input;
  if (!(ignore instanceof Array))
    ignore = ignore.split(" ");

  ignore.forEach((del: string) => {
    output = output.replace(del, "");
  });

  output = output.replace(/__+/, "_");
  if (output[output.length - 1] === "_")
    output = output.slice(0, output.length - 1);

  return output;
}

function getRenderMode(vp: ScreenViewport): string {
  switch (vp.viewFlags.renderMode) {
    case RenderMode.Wireframe: return "Wireframe";
    case RenderMode.HiddenLine: return "HiddenLine";
    case RenderMode.SolidFill: return "SolidFill";
    case RenderMode.SmoothShade: return "SmoothShade";
    default: return "";
  }
}

function getRenderOpts(opts: RenderSystem.Options): string {
  let optString = "";
  for (const propName of Object.keys(opts)) {
    const key = propName as keyof RenderSystem.Options;
    switch (key) {
      case "disabledExtensions": {
        const extensions = opts[key];
        if (extensions) {
          for (const ext of extensions) {
            switch (ext) {
              case "WEBGL_draw_buffers":
                optString += "-drawBuf";
                break;
              case "OES_element_index_uint":
                optString += "-unsignedInt";
                break;
              case "OES_texture_float":
                optString += "-texFloat";
                break;
              case "OES_texture_half_float":
                optString += "-texHalfFloat";
                break;
              case "WEBGL_depth_texture":
                optString += "-depthTex";
                break;
              case "EXT_color_buffer_float":
                optString += "-floats";
                break;
              case "EXT_shader_texture_lod":
                optString += "-texLod";
                break;
              case "ANGLE_instanced_arrays":
                optString += "-instArrays";
                break;
              case "EXT_frag_depth":
                optString += "-fragDepth";
                break;
            }
          }
        }
        break;
      }
      case "displaySolarShadows":
        if (!opts[key])
          optString += "-solShd";

        break;
      case "useWebGL2":
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        if (opts[key])
          optString += "+webGL2";

        break;
      case "antialiasSamples": {
        const value = opts[key];
        if (undefined !== value && value > 1)
          optString += `+aa${value}`;

        break;
      }
    }
  }

  return optString;
}

function getTileProps(props: TileAdmin.Props): string {
  let tilePropsStr = "";

  for (const propName of Object.keys(props)) {
    const key = propName as keyof TileAdmin.Props;
    switch (key) {
      case "enableInstancing":
        if (props[key])
          tilePropsStr += "+inst";

        break;
      case "disableMagnification":
        if (props[key])
          tilePropsStr += "-mag";

        break;
      case "enableIndexedEdges":
        if (!props[key])
          tilePropsStr += "-idxEdg";

        break;
      case "generateAllPolyfaceEdges":
        if (!props[key])
          tilePropsStr += "-pfEdg";

        break;
    }
  }

  return tilePropsStr;
}

function getBackgroundMapProps(vp: ScreenViewport): string {
  let bmPropsStr = "";
  const layer = vp.displayStyle.settings.mapImagery.backgroundBase;
  if (layer instanceof BaseMapLayerSettings && layer.provider) {
    switch (layer.provider.name) {
      case "BingProvider":
        break;
      case "MapBoxProvider":
        bmPropsStr += "MapBox";
        break;
    }

    switch (layer.provider.type) {
      case BackgroundMapType.Hybrid:
        break;
      case BackgroundMapType.Aerial:
        bmPropsStr += "+aer";
        break;
      case BackgroundMapType.Street:
        bmPropsStr += "+st";
        break;
    }
  }

  const bmProps = vp.displayStyle.settings.backgroundMap;
  if (bmProps.groundBias !== 0)
    bmPropsStr += `+bias${bmProps.groundBias}`;

  if (bmProps.applyTerrain)
    bmPropsStr += "+terr";

  if (bmProps.useDepthBuffer)
    bmPropsStr += "+depth";

  if (typeof (bmProps.transparency) === "number")
    bmPropsStr += `+trans${bmProps.transparency}`;

  return bmPropsStr;
}

function hiliteSettingsStr(settings: Hilite.Settings): string {
  let hsStr = (settings.color.colors.r * 256 * 256 + settings.color.colors.g * 256 + settings.color.colors.b).toString(36).padStart(5, "0");
  hsStr += (settings.silhouette * 256 * 256 + Math.round(settings.visibleRatio * 255) * 256 + Math.round(settings.hiddenRatio * 255)).toString(36).padStart(4, "0");
  return hsStr.toUpperCase();
}

function getHyperModelingProps(props: HyperModelingProps | undefined): string | undefined {
  if (!props)
    return undefined;

  const hm = `+hm${props.sectionDrawingLocationId}`;
  return props.applySpatialView ? `${hm}+a` : hm;
}

function getOtherProps(vp: ScreenViewport): string {
  let propsStr = "";
  if (!Hilite.equalSettings(vp.hilite, defaultHilite))
    propsStr += `+h${hiliteSettingsStr(vp.hilite)}`;

  if (!Hilite.equalSettings(vp.emphasisSettings, defaultEmphasis))
    propsStr += `+e${hiliteSettingsStr(vp.emphasisSettings)}`;

  return propsStr;
}

const viewFlagsPropsStrings = {
  dimensions: "-dim",
  patterns: "-pat",
  weights: "-wt",
  styles: "-sty",
  transparency: "-trn",
  fill: "-fll",
  textures: "-txt",
  materials: "-mat",
  visibleEdges: "+vsE",
  hiddenEdges: "+hdE",
  shadows: "+shd",
  clipVolume: "-clp",
  constructions: "+con",
  monochrome: "+mno",
  backgroundMap: "+bkg",
  ambientOcclusion: "+ao",
  forceSurfaceDiscard: "+fsd",
  thematicDisplay: "+thematicDisplay",
  grid: "+grid",
  whiteOnWhiteReversal: "+wow",
  acsTriad: "+acsTriad",
  wiremesh: "+wm",
};

function getViewFlagsString(test: TestCase): string {
  let vfString = "";

  // Lighting flag always comes first.
  const vf = test.viewport.viewFlags;
  if (vf.lighting && RenderMode.SmoothShade === vf.renderMode)
    vfString = "+lit";

  for (const propName of Object.keys(vf)) {
    const key = propName as keyof typeof viewFlagsPropsStrings;
    const abbrev = viewFlagsPropsStrings[key];
    if (!abbrev)
      continue;

    assert("-" === abbrev[0] || "+" === abbrev[0]);
    const includeIf = "+" === abbrev[0];
    if (vf[key] === includeIf)
      vfString += abbrev;
  }

  if (undefined !== test.view.elementOverrides)
    vfString += "+ovrEl";

  if (undefined !== test.view.selectedElements)
    vfString += "+selEl";

  return vfString;
}

function getBrowserName(userAgent: string): string {
  const lowUserAgent = userAgent.toLowerCase();
  if (lowUserAgent.includes("electron"))
    return "Electron";
  if (lowUserAgent.includes("firefox"))
    return "FireFox";
  if (lowUserAgent.includes("edge"))
    return "Edge";
  if (lowUserAgent.includes("chrome") && !userAgent.includes("chromium"))
    return "Chrome";
  if (lowUserAgent.includes("safari") && !userAgent.includes("chrome") && !userAgent.includes("chromium"))
    return "Safari";
  return "Unknown";
}

/** See https://stackoverflow.com/questions/26246601/wildcard-string-comparison-in-javascript
 * Compare strToTest with a given rule containing a wildcard, and will return true if strToTest matches the given wildcard
 * Make sure it is case-insensitive
 */
function matchRule(strToTest: string, rule: string) {
  strToTest = strToTest.toLowerCase();
  rule = rule.toLowerCase();
  const escapeRegex = (str: string) => str.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
  return new RegExp(`^${rule.split("*").map(escapeRegex).join(".*")}$`).test(strToTest);
}

interface SelectedTileStats {
  /* A formatted string containing the Ids of all the tiles that were selected for display by the last call to waitForTilesToLoad(), of the format:
   *  Selected Tiles:
   *    TreeId1: tileId1,tileId2,...
   *    TreeId2: tileId1,tileId2,...
   *    ...
   * Sorted by tree Id and then by tile Id so that the output is consistent from run to run unless the set of selected tiles changed between runs.
   */
  ids: string;
  /** The number of selected tiles. */
  count: number;
  /** The number of bytes of memory allocated to the GPU for the selected tiles' graphics. */
  gpuBytes: number;
}

function getSelectedTileStats(vp: ScreenViewport): SelectedTileStats {
  let formattedSelectedTileIds = "Selected tiles:\n";
  let count = 0;
  const mem = new RenderMemory.Statistics();
  const dict = new Dictionary<string, SortedArray<string>>((lhs, rhs) => lhs.localeCompare(rhs));
  for (const viewport of [vp, ...vp.view.secondaryViewports]) {
    const selected = IModelApp.tileAdmin.getTilesForUser(viewport)?.selected;
    if (!selected)
      continue;

    count += selected.size;
    for (const tile of selected) {
      const treeId = tile.tree.id;
      let tileIds = dict.get(treeId);
      if (!tileIds)
        dict.set(treeId, tileIds = new SortedArray<string>((lhs, rhs) => lhs.localeCompare(rhs)));

      tileIds.insert(tile.contentId);
      tile.collectStatistics(mem);
    }
  }

  for (const kvp of dict) {
    const contentIds = kvp.value.extractArray().join(",");
    const line = `  ${kvp.key}: ${contentIds}`;
    formattedSelectedTileIds = `${formattedSelectedTileIds}${line}\n`;
  }

  return {
    ids: formattedSelectedTileIds,
    count,
    gpuBytes: mem.totalBytes,
  };
}

function calcGpuBytes(func: (stats: RenderMemory.Statistics) => void): number {
  const stats = new RenderMemory.Statistics();
  func(stats);
  return stats.totalBytes;
}

async function savePng(fileName: string, canvas: HTMLCanvasElement): Promise<void> {
  const img = canvas.toDataURL("image/png");
  const data = img.replace(/^data:image\/\w+;base64,/, ""); // strip off the data: url prefix to get just the base64-encoded bytes
  return DisplayPerfRpcInterface.getClient().savePng(fileName, data);
}

function setPerformanceMetrics(vp: ScreenViewport, metrics: PerformanceMetrics | undefined): void {
  (vp.target as Target).performanceMetrics = metrics;
}
