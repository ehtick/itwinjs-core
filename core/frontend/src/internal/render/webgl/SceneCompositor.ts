/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module WebGL
 */

import { assert, dispose, Id64String } from "@itwin/core-bentley";
import { Transform, Vector2d, Vector3d } from "@itwin/core-geometry";
import {
    ContourDisplay,
  ModelFeature, PointCloudDisplaySettings, RenderFeatureTable, RenderMode, SpatialClassifierInsideDisplay, SpatialClassifierOutsideDisplay,
} from "@itwin/core-common";
import { RenderType } from "@itwin/webgl-compatibility";
import { IModelConnection } from "../../../IModelConnection";
import { SceneContext } from "../../../ViewContext";
import { ContourHit } from "../../../HitDetail";
import { ViewRect } from "../../../common/ViewRect";
import { Pixel } from "../../../render/Pixel";
import { GraphicList } from "../../../render/RenderGraphic";
import { RenderMemory } from "../../../render/RenderMemory";
import { BranchState } from "./BranchState";
import { BatchState } from "./BatchState";
import {
  AmbientOcclusionGeometry, BlurGeometry, BlurType, BoundaryType, CachedGeometry, CompositeGeometry, CopyPickBufferGeometry,
  SingleTexturedViewportQuadGeometry, ViewportQuadGeometry, VolumeClassifierGeometry,
} from "./CachedGeometry";
import { Debug } from "./Diagnostics";
import { WebGLDisposable } from "./Disposable";
import { DrawCommands, extractFlashedVolumeClassifierCommands, extractHilitedVolumeClassifierCommands } from "./DrawCommand";
import { DepthBuffer, FrameBuffer } from "./FrameBuffer";
import { GL } from "./GL";
import { IModelFrameLifecycle } from "./IModelFrameLifecycle";
import { Matrix4 } from "./Matrix";
import { RenderCommands } from "./RenderCommands";
import { CompositeFlags, RenderOrder, RenderPass, TextureUnit } from "./RenderFlags";
import { RenderState } from "./RenderState";
import { getDrawParams } from "./ScratchDrawParams";
import { SolarShadowMap } from "./SolarShadowMap";
import { System } from "./System";
import { Target } from "./Target";
import { TechniqueId } from "./TechniqueId";
import { TextureHandle } from "./Texture";
import { RenderBufferMultiSample } from "./RenderBuffer";
import { Primitive } from "./Primitive";
import { ShaderProgramExecutor } from "./ShaderProgram";
import { EDLMode, EyeDomeLighting } from "./EDL";
import { FrustumUniformType } from "./FrustumUniforms";

export function collectTextureStatistics(texture: TextureHandle | undefined, stats: RenderMemory.Statistics): void {
  if (undefined !== texture)
    stats.addTextureAttachment(texture.bytesUsed);
}

function collectMsBufferStatistics(msBuff: RenderBufferMultiSample | undefined, stats: RenderMemory.Statistics): void {
  if (undefined !== msBuff)
    stats.addTextureAttachment(msBuff.bytesUsed);
}

// Maintains the textures used by a SceneCompositor. The textures are reallocated when the dimensions of the viewport change.
class Textures implements WebGLDisposable, RenderMemory.Consumer {
  public accumulation?: TextureHandle;
  public revealage?: TextureHandle;
  public color?: TextureHandle;
  public featureId?: TextureHandle;
  public depthAndOrder?: TextureHandle;
  public depthAndOrderHidden?: TextureHandle; // only used if AO and multisampling
  public contours?: TextureHandle;
  public contoursMsBuff?: RenderBufferMultiSample;
  public hilite?: TextureHandle;
  public occlusion?: TextureHandle;
  public occlusionBlur?: TextureHandle;
  public volClassBlend?: TextureHandle;
  public colorMsBuff?: RenderBufferMultiSample;
  public featureIdMsBuff?: RenderBufferMultiSample;
  public featureIdMsBuffHidden?: RenderBufferMultiSample;
  public depthAndOrderMsBuff?: RenderBufferMultiSample;
  public depthAndOrderMsBuffHidden?: RenderBufferMultiSample;
  public hiliteMsBuff?: RenderBufferMultiSample;
  public volClassBlendMsBuff?: RenderBufferMultiSample;

  public get isDisposed(): boolean {
    return undefined === this.accumulation
      && undefined === this.revealage
      && undefined === this.color
      && undefined === this.featureId
      && undefined === this.depthAndOrder
      && undefined === this.contours
      && undefined === this.contoursMsBuff
      && undefined === this.depthAndOrderHidden
      && undefined === this.hilite
      && undefined === this.occlusion
      && undefined === this.occlusionBlur
      && undefined === this.volClassBlend
      && undefined === this.colorMsBuff
      && undefined === this.featureIdMsBuff
      && undefined === this.featureIdMsBuffHidden
      && undefined === this.depthAndOrderMsBuff
      && undefined === this.depthAndOrderMsBuffHidden
      && undefined === this.hiliteMsBuff
      && undefined === this.volClassBlendMsBuff;
  }

  public [Symbol.dispose]() {
    this.accumulation = dispose(this.accumulation);
    this.revealage = dispose(this.revealage);
    this.color = dispose(this.color);
    this.featureId = dispose(this.featureId);
    this.depthAndOrder = dispose(this.depthAndOrder);
    this.contours = dispose(this.contours);
    this.contoursMsBuff = dispose(this.contoursMsBuff);
    this.depthAndOrderHidden = dispose(this.depthAndOrderHidden);
    this.hilite = dispose(this.hilite);
    this.occlusion = dispose(this.occlusion);
    this.occlusionBlur = dispose(this.occlusionBlur);
    this.colorMsBuff = dispose(this.colorMsBuff);
    this.featureIdMsBuff = dispose(this.featureIdMsBuff);
    this.featureIdMsBuffHidden = dispose(this.featureIdMsBuffHidden);
    this.depthAndOrderMsBuff = dispose(this.depthAndOrderMsBuff);
    this.depthAndOrderMsBuffHidden = dispose(this.depthAndOrderMsBuffHidden);
    this.hiliteMsBuff = dispose(this.hiliteMsBuff);
    this.volClassBlend = dispose(this.volClassBlend);
    this.volClassBlendMsBuff = dispose(this.volClassBlendMsBuff);
  }

  public collectStatistics(stats: RenderMemory.Statistics): void {
    collectTextureStatistics(this.accumulation, stats);
    collectTextureStatistics(this.revealage, stats);
    collectTextureStatistics(this.color, stats);
    collectTextureStatistics(this.featureId, stats);
    collectTextureStatistics(this.depthAndOrder, stats);
    collectTextureStatistics(this.contours, stats);
    collectMsBufferStatistics(this.contoursMsBuff, stats);
    collectTextureStatistics(this.depthAndOrderHidden, stats);
    collectTextureStatistics(this.hilite, stats);
    collectTextureStatistics(this.occlusion, stats);
    collectTextureStatistics(this.occlusionBlur, stats);
    collectTextureStatistics(this.volClassBlend, stats);
    collectMsBufferStatistics(this.colorMsBuff, stats);
    collectMsBufferStatistics(this.featureIdMsBuff, stats);
    collectMsBufferStatistics(this.featureIdMsBuffHidden, stats);
    collectMsBufferStatistics(this.depthAndOrderMsBuff, stats);
    collectMsBufferStatistics(this.depthAndOrderMsBuffHidden, stats);
    collectMsBufferStatistics(this.hiliteMsBuff, stats);
    collectMsBufferStatistics(this.volClassBlendMsBuff, stats);
  }

  public init(width: number, height: number, numSamples: number): boolean {
    assert(undefined === this.accumulation);

    let pixelDataType: GL.Texture.DataType = GL.Texture.DataType.UnsignedByte;
    switch (System.instance.maxRenderType) {
      case RenderType.TextureFloat: {
        pixelDataType = GL.Texture.DataType.Float;
        break;
      }
      case RenderType.TextureHalfFloat: {
        pixelDataType = System.instance.context.HALF_FLOAT;
        break;
      }
      /* falls through */
      case RenderType.TextureUnsignedByte: {
        break;
      }
    }

    // NB: Both of these must be of the same type, because they are borrowed by pingpong and bound to the same frame buffer.
    this.accumulation = TextureHandle.createForAttachment(width, height, GL.Texture.Format.Rgba, pixelDataType);
    this.revealage = TextureHandle.createForAttachment(width, height, GL.Texture.Format.Rgba, pixelDataType);

    // Hilite texture is a simple on-off, but the smallest texture format WebGL allows us to use as output is RGBA with a byte per component.
    this.hilite = TextureHandle.createForAttachment(width, height, GL.Texture.Format.Rgba, GL.Texture.DataType.UnsignedByte);

    this.color = TextureHandle.createForAttachment(width, height, GL.Texture.Format.Rgba, GL.Texture.DataType.UnsignedByte);

    this.featureId = TextureHandle.createForAttachment(width, height, GL.Texture.Format.Rgba, GL.Texture.DataType.UnsignedByte);
    this.depthAndOrder = TextureHandle.createForAttachment(width, height, GL.Texture.Format.Rgba, GL.Texture.DataType.UnsignedByte);
    this.contours = TextureHandle.createForAttachment(width, height, GL.Texture.Format.Rgba, GL.Texture.DataType.UnsignedByte);

    let rVal = undefined !== this.accumulation
      && undefined !== this.revealage
      && undefined !== this.color
      && undefined !== this.featureId
      && undefined !== this.depthAndOrder
      && undefined !== this.contours
      && undefined !== this.hilite;

    if (rVal && numSamples > 1) {
      rVal = this.enableMultiSampling(width, height, numSamples);
    }

    return rVal;
  }

  public enableOcclusion(width: number, height: number, numSamples: number): boolean {
    assert(undefined === this.occlusion && undefined === this.occlusionBlur);
    this.occlusion = TextureHandle.createForAttachment(width, height, GL.Texture.Format.Rgba, GL.Texture.DataType.UnsignedByte);
    this.occlusionBlur = TextureHandle.createForAttachment(width, height, GL.Texture.Format.Rgba, GL.Texture.DataType.UnsignedByte);
    let rVal = undefined !== this.occlusion && undefined !== this.occlusionBlur;
    if (numSamples > 1) {
      // If multisampling then we need a texture for storing depth and order for hidden edges.
      this.depthAndOrderHidden = TextureHandle.createForAttachment(width, height, GL.Texture.Format.Rgba, GL.Texture.DataType.UnsignedByte);
      rVal = rVal && undefined !== this.depthAndOrderHidden;
    }
    return rVal;
  }

  public disableOcclusion(): void {
    assert(undefined !== this.occlusion && undefined !== this.occlusionBlur);
    this.occlusion = dispose(this.occlusion);
    this.occlusionBlur = dispose(this.occlusionBlur);
    this.depthAndOrderHidden = dispose(this.depthAndOrderHidden);
  }

  public enableVolumeClassifier(width: number, height: number, numSamples: number): boolean {
    assert(undefined === this.volClassBlend);
    this.volClassBlend = TextureHandle.createForAttachment(width, height, GL.Texture.Format.Rgba, GL.Texture.DataType.UnsignedByte);
    let rVal = undefined !== this.volClassBlend;
    if (rVal && undefined !== numSamples && numSamples > 1) {
      this.volClassBlendMsBuff = RenderBufferMultiSample.create(width, height, WebGL2RenderingContext.RGBA8, numSamples);
      rVal = undefined !== this.volClassBlendMsBuff;
    }
    return rVal;
  }

  public disableVolumeClassifier(): void {
    this.volClassBlend = dispose(this.volClassBlend);
    this.volClassBlendMsBuff = dispose(this.volClassBlendMsBuff);
  }

  public enableMultiSampling(width: number, height: number, numSamples: number): boolean {
    this.colorMsBuff = RenderBufferMultiSample.create(width, height, WebGL2RenderingContext.RGBA8, numSamples);
    this.featureIdMsBuff = RenderBufferMultiSample.create(width, height, WebGL2RenderingContext.RGBA8, numSamples);
    this.featureIdMsBuffHidden = RenderBufferMultiSample.create(width, height, WebGL2RenderingContext.RGBA8, numSamples);
    this.depthAndOrderMsBuff = RenderBufferMultiSample.create(width, height, WebGL2RenderingContext.RGBA8, numSamples);
    this.depthAndOrderMsBuffHidden = RenderBufferMultiSample.create(width, height, WebGL2RenderingContext.RGBA8, numSamples);
    this.contoursMsBuff = RenderBufferMultiSample.create(width, height, WebGL2RenderingContext.RGBA8, numSamples);
    this.hiliteMsBuff = RenderBufferMultiSample.create(width, height, WebGL2RenderingContext.RGBA8, numSamples);
    return undefined !== this.colorMsBuff
      && undefined !== this.featureIdMsBuff
      && undefined !== this.featureIdMsBuffHidden
      && undefined !== this.depthAndOrderMsBuff
      && undefined !== this.depthAndOrderMsBuffHidden
      && undefined !== this.contoursMsBuff
      && undefined !== this.hiliteMsBuff;
  }

  public disableMultiSampling(): boolean {
    this.colorMsBuff = dispose(this.colorMsBuff);
    this.featureIdMsBuff = dispose(this.featureIdMsBuff);
    this.featureIdMsBuffHidden = dispose(this.featureIdMsBuffHidden);
    this.depthAndOrderMsBuff = dispose(this.depthAndOrderMsBuff);
    this.depthAndOrderMsBuffHidden = dispose(this.depthAndOrderMsBuffHidden);
    this.contoursMsBuff = dispose(this.contoursMsBuff);
    this.hiliteMsBuff = dispose(this.hiliteMsBuff);
    return true;
  }
}

// Maintains the framebuffers used by a SceneCompositor. The color attachments are supplied by a Textures object.
class FrameBuffers implements WebGLDisposable {
  public opaqueColor?: FrameBuffer;
  public opaqueAndCompositeColor?: FrameBuffer;
  public depthAndOrder?: FrameBuffer;
  public contours?: FrameBuffer;
  public hilite?: FrameBuffer;
  public hiliteUsingStencil?: FrameBuffer;
  public stencilSet?: FrameBuffer;
  public occlusion?: FrameBuffer;
  public occlusionBlur?: FrameBuffer;
  public altZOnly?: FrameBuffer;
  public volClassCreateBlend?: FrameBuffer;
  public volClassCreateBlendAltZ?: FrameBuffer;
  public opaqueAll?: FrameBuffer;
  public opaqueAndCompositeAll?: FrameBuffer;
  public opaqueAndCompositeAllHidden?: FrameBuffer;
  public pingPong?: FrameBuffer;
  public pingPongMS?: FrameBuffer;
  public translucent?: FrameBuffer;
  public clearTranslucent?: FrameBuffer;
  public idsAndZ?: FrameBuffer;
  public idsAndAltZ?: FrameBuffer;
  public idsAndZComposite?: FrameBuffer;
  public idsAndAltZComposite?: FrameBuffer;
  public edlDrawCol?: FrameBuffer;

  public init(textures: Textures, depth: DepthBuffer, depthMS: DepthBuffer | undefined): boolean {
    if (!this.initPotentialMSFbos(textures, depth, depthMS))
      return false;

    this.depthAndOrder = FrameBuffer.create([textures.depthAndOrder!], depth);
    this.contours = FrameBuffer.create([textures.contours!], depth);
    this.hilite = FrameBuffer.create([textures.hilite!], depth);
    this.hiliteUsingStencil = FrameBuffer.create([textures.hilite!], depth);

    if (!this.depthAndOrder || !this.contours || !this.hilite || !this.hiliteUsingStencil)
      return false;

    assert(undefined === this.opaqueAll);

    if (!this.initPotentialMSMRTFbos(textures, depth, depthMS))
      return false;

    assert(undefined !== textures.accumulation && undefined !== textures.revealage);
    const colors = [textures.accumulation, textures.revealage];
    this.translucent = FrameBuffer.create(colors, depth);
    this.clearTranslucent = FrameBuffer.create(colors);

    // We borrow the SceneCompositor's accum and revealage textures for the surface pass.
    // First we render edges, writing to our textures.
    // Then we copy our textures to borrowed textures.
    // Finally we render surfaces, writing to our textures and reading from borrowed textures.
    assert(undefined !== textures.accumulation && undefined !== textures.revealage);
    const pingPong = [textures.accumulation, textures.revealage];
    this.pingPong = FrameBuffer.create(pingPong);

    return undefined !== this.translucent
      && undefined !== this.clearTranslucent
      && undefined !== this.pingPong;
  }

  private initPotentialMSFbos(textures: Textures, depth: DepthBuffer, depthMS: DepthBuffer | undefined): boolean {
    const boundColor = System.instance.frameBufferStack.currentColorBuffer;
    assert(undefined !== boundColor && undefined !== textures.color);
    if (undefined === depthMS) {
      this.opaqueColor = FrameBuffer.create([boundColor], depth);
      this.opaqueAndCompositeColor = FrameBuffer.create([textures.color], depth);
    } else {
      assert(undefined !== textures.colorMsBuff);
      this.opaqueColor = FrameBuffer.create([boundColor], depth, [textures.colorMsBuff], [GL.MultiSampling.Filter.Linear], depthMS);
      this.opaqueAndCompositeColor = FrameBuffer.create([textures.color], depth, [textures.colorMsBuff], [GL.MultiSampling.Filter.Linear], depthMS);
    }
    return undefined !== this.opaqueColor
      && undefined !== this.opaqueAndCompositeColor;
  }

  private initPotentialMSMRTFbos(textures: Textures, depth: DepthBuffer, depthMs: DepthBuffer | undefined): boolean {
    const boundColor = System.instance.frameBufferStack.currentColorBuffer;
    assert(
      undefined !== boundColor &&
      undefined !== textures.color &&
      undefined !== textures.featureId &&
      undefined !== textures.depthAndOrder &&
      undefined !== textures.contours &&
      undefined !== textures.accumulation &&
      undefined !== textures.revealage
    );
    const colorAndPick = [boundColor, textures.featureId, textures.depthAndOrder, textures.contours];

    if (undefined === depthMs) {
      this.opaqueAll = FrameBuffer.create(colorAndPick, depth);
      colorAndPick[0] = textures.color;
      this.opaqueAndCompositeAll = FrameBuffer.create(colorAndPick, depth);
    } else {
      assert(
        undefined !== textures.colorMsBuff &&
        undefined !== textures.featureIdMsBuff &&
        undefined !== textures.featureIdMsBuffHidden &&
        undefined !== textures.contoursMsBuff &&
        undefined !== textures.depthAndOrderMsBuff &&
        undefined !== textures.depthAndOrderMsBuffHidden
      );
      const colorAndPickMsBuffs = [textures.colorMsBuff, textures.featureIdMsBuff, textures.depthAndOrderMsBuff, textures.contoursMsBuff];
      const colorAndPickFilters = [GL.MultiSampling.Filter.Linear, GL.MultiSampling.Filter.Nearest, GL.MultiSampling.Filter.Nearest, GL.MultiSampling.Filter.Nearest];
      this.opaqueAll = FrameBuffer.create(colorAndPick, depth, colorAndPickMsBuffs, colorAndPickFilters, depthMs);
      colorAndPick[0] = textures.color;
      this.opaqueAndCompositeAll = FrameBuffer.create(colorAndPick, depth, colorAndPickMsBuffs, colorAndPickFilters, depthMs);
    }

    return undefined !== this.opaqueAll
      && undefined !== this.opaqueAndCompositeAll;
  }

  public enableOcclusion(textures: Textures, depth: DepthBuffer, depthMs: DepthBuffer | undefined): boolean {
    assert(undefined !== textures.occlusion && undefined !== textures.occlusionBlur);
    this.occlusion = FrameBuffer.create([textures.occlusion]);
    this.occlusionBlur = FrameBuffer.create([textures.occlusionBlur]);
    let rVal = undefined !== this.occlusion && undefined !== this.occlusionBlur;

    if (undefined === depthMs) {
      // If not using multisampling then we can use the accumulation and revealage textures for the hidden pick buffers,
      assert(undefined !== textures.color && undefined !== textures.accumulation && undefined !== textures.revealage);
      const colorAndPick = [textures.color, textures.accumulation, textures.revealage];
      this.opaqueAndCompositeAllHidden = FrameBuffer.create(colorAndPick, depth);
      rVal = rVal && undefined !== this.opaqueAndCompositeAllHidden;
    } else {
      // If multisampling then we cannot use the revealage texture for depthAndOrder for the hidden edges since it is of the wrong type for blitting,
      // so instead use a special depthAndOrderHidden texture just for this purpose.
      // The featureId texture is not needed for hidden edges, so the accumulation texture can be used for it if we don't blit from the multisample bufffer into it.
      assert(undefined !== textures.color && undefined !== textures.accumulation && undefined !== textures.depthAndOrderHidden);
      assert(undefined !== textures.colorMsBuff && undefined !== textures.featureIdMsBuffHidden && undefined !== textures.depthAndOrderMsBuffHidden);
      const colorAndPick = [textures.color, textures.accumulation, textures.depthAndOrderHidden];
      const colorAndPickMsBuffs = [textures.colorMsBuff, textures.featureIdMsBuffHidden, textures.depthAndOrderMsBuffHidden];
      const colorAndPickFilters = [GL.MultiSampling.Filter.Linear, GL.MultiSampling.Filter.Nearest, GL.MultiSampling.Filter.Nearest];
      this.opaqueAndCompositeAllHidden = FrameBuffer.create(colorAndPick, depth, colorAndPickMsBuffs, colorAndPickFilters, depthMs);
      // We will also need a frame buffer for copying the real pick data buffers into these hidden edge pick data buffers.
      const pingPong = [textures.accumulation, textures.depthAndOrderHidden];
      const pingPongMSBuffs = [textures.featureIdMsBuffHidden, textures.depthAndOrderMsBuffHidden];
      const pingPongFilters = [GL.MultiSampling.Filter.Nearest, GL.MultiSampling.Filter.Nearest];
      this.pingPongMS = FrameBuffer.create(pingPong, depth, pingPongMSBuffs, pingPongFilters, depthMs);
      rVal = rVal && undefined !== this.opaqueAndCompositeAllHidden && (undefined === depthMs || undefined !== this.pingPongMS);
    }

    return rVal;
  }

  public disableOcclusion(): void {
    if (undefined !== this.occlusion) {
      this.occlusion = dispose(this.occlusion);
      this.occlusionBlur = dispose(this.occlusionBlur);
    }

    this.opaqueAndCompositeAllHidden = dispose(this.opaqueAndCompositeAllHidden);
    this.pingPongMS = dispose(this.pingPongMS);
  }

  public enableVolumeClassifier(textures: Textures, depth: DepthBuffer, volClassDepth: DepthBuffer | undefined, depthMS?: DepthBuffer, volClassDepthMS?: DepthBuffer): void {
    const boundColor = System.instance.frameBufferStack.currentColorBuffer;
    if (undefined === boundColor)
      return;

    if (undefined === this.stencilSet) {
      if (undefined !== depthMS) { // if multisampling use the multisampled depth everywhere
        this.stencilSet = FrameBuffer.create([], depth, [], [], depthMS);
        this.altZOnly = FrameBuffer.create([], volClassDepth, [], [], volClassDepthMS);
        this.volClassCreateBlend = FrameBuffer.create([textures.volClassBlend!], depth, [textures.volClassBlendMsBuff!], [GL.MultiSampling.Filter.Nearest], depthMS);
        this.volClassCreateBlendAltZ = FrameBuffer.create([textures.volClassBlend!], volClassDepth, [textures.volClassBlendMsBuff!], [GL.MultiSampling.Filter.Nearest], volClassDepthMS);
      } else if (undefined !== volClassDepth) {
        this.stencilSet = FrameBuffer.create([], depth);
        this.altZOnly = FrameBuffer.create([], volClassDepth);
        this.volClassCreateBlend = FrameBuffer.create([textures.volClassBlend!], depth);
        this.volClassCreateBlendAltZ = FrameBuffer.create([textures.volClassBlend!], volClassDepth);
      }
    }

    if (undefined !== this.opaqueAll && undefined !== this.opaqueAndCompositeAll) {
      if (undefined !== volClassDepth) {
        let ids = [this.opaqueAll.getColor(0), this.opaqueAll.getColor(1)];
        this.idsAndZ = FrameBuffer.create(ids, depth);
        this.idsAndAltZ = FrameBuffer.create(ids, volClassDepth);
        ids = [this.opaqueAndCompositeAll.getColor(0), this.opaqueAndCompositeAll.getColor(1)];
        this.idsAndZComposite = FrameBuffer.create(ids, depth);
        this.idsAndAltZComposite = FrameBuffer.create(ids, volClassDepth);
      }
    }
  }

  public disableVolumeClassifier(): void {
    if (undefined !== this.stencilSet) {
      this.stencilSet = dispose(this.stencilSet);
      this.altZOnly = dispose(this.altZOnly);
      this.volClassCreateBlend = dispose(this.volClassCreateBlend);
      this.volClassCreateBlendAltZ = dispose(this.volClassCreateBlendAltZ);
    }

    if (undefined !== this.idsAndZ) {
      this.idsAndZ = dispose(this.idsAndZ);
      this.idsAndAltZ = dispose(this.idsAndAltZ);
      this.idsAndZComposite = dispose(this.idsAndZComposite);
      this.idsAndAltZComposite = dispose(this.idsAndAltZComposite);
    }
  }

  public enableMultiSampling(textures: Textures, depth: DepthBuffer, depthMS: DepthBuffer): boolean {
    this.opaqueColor = dispose(this.opaqueColor);
    this.opaqueAndCompositeColor = dispose(this.opaqueAndCompositeColor);
    let rVal = this.initPotentialMSFbos(textures, depth, depthMS);

    this.opaqueAll = dispose(this.opaqueAll);
    this.opaqueAndCompositeAll = dispose(this.opaqueAndCompositeAll);
    rVal = this.initPotentialMSMRTFbos(textures, depth, depthMS);
    return rVal;
  }

  public disableMultiSampling(textures: Textures, depth: DepthBuffer): boolean {
    this.opaqueAll = dispose(this.opaqueAll);
    this.opaqueAndCompositeAll = dispose(this.opaqueAndCompositeAll);
    if (!this.initPotentialMSMRTFbos(textures, depth, undefined))
      return false;

    this.opaqueColor = dispose(this.opaqueColor);
    this.opaqueAndCompositeColor = dispose(this.opaqueAndCompositeColor);
    return this.initPotentialMSFbos(textures, depth, undefined);
  }

  public get isDisposed(): boolean {
    return undefined === this.opaqueColor && undefined === this.opaqueAndCompositeColor && undefined === this.depthAndOrder && undefined === this.contours
      && undefined === this.hilite && undefined === this.hiliteUsingStencil && undefined === this.occlusion
      && undefined === this.occlusionBlur && undefined === this.stencilSet && undefined === this.altZOnly
      && undefined === this.volClassCreateBlend && undefined === this.volClassCreateBlendAltZ && undefined === this.opaqueAll
      && undefined === this.opaqueAndCompositeAll && undefined === this.opaqueAndCompositeAllHidden && undefined === this.pingPong
      && undefined === this.pingPongMS && undefined === this.translucent && undefined === this.clearTranslucent
      && undefined === this.idsAndZ && undefined === this.idsAndAltZ && undefined === this.idsAndZComposite
      && undefined === this.idsAndAltZComposite && undefined === this.edlDrawCol;
  }

  public [Symbol.dispose]() {
    this.opaqueColor = dispose(this.opaqueColor);
    this.opaqueAndCompositeColor = dispose(this.opaqueAndCompositeColor);
    this.depthAndOrder = dispose(this.depthAndOrder);
    this.contours = dispose(this.contours);
    this.hilite = dispose(this.hilite);
    this.hiliteUsingStencil = dispose(this.hiliteUsingStencil);
    this.occlusion = dispose(this.occlusion);
    this.occlusionBlur = dispose(this.occlusionBlur);
    this.stencilSet = dispose(this.stencilSet);
    this.altZOnly = dispose(this.altZOnly);
    this.volClassCreateBlend = dispose(this.volClassCreateBlend);
    this.volClassCreateBlendAltZ = dispose(this.volClassCreateBlendAltZ);

    this.opaqueAll = dispose(this.opaqueAll);
    this.opaqueAndCompositeAll = dispose(this.opaqueAndCompositeAll);
    this.opaqueAndCompositeAll = dispose(this.opaqueAndCompositeAllHidden);
    this.pingPong = dispose(this.pingPong);
    this.pingPongMS = dispose(this.pingPongMS);
    this.translucent = dispose(this.translucent);
    this.clearTranslucent = dispose(this.clearTranslucent);
    this.idsAndZ = dispose(this.idsAndZ);
    this.idsAndAltZ = dispose(this.idsAndAltZ);
    this.idsAndZComposite = dispose(this.idsAndZComposite);
    this.idsAndAltZComposite = dispose(this.idsAndAltZComposite);
    this.edlDrawCol = dispose(this.edlDrawCol);
  }
}

export function collectGeometryStatistics(geom: CachedGeometry | undefined, stats: RenderMemory.Statistics): void {
  if (undefined !== geom)
    geom.collectStatistics(stats);
}

// Maintains the geometry used to execute screenspace operations for a SceneCompositor.
class Geometry implements WebGLDisposable, RenderMemory.Consumer {
  public composite?: CompositeGeometry;
  public volClassColorStencil?: ViewportQuadGeometry;
  public volClassCopyZ?: SingleTexturedViewportQuadGeometry;
  public volClassSetBlend?: VolumeClassifierGeometry;
  public volClassBlend?: SingleTexturedViewportQuadGeometry;
  public occlusion?: AmbientOcclusionGeometry;
  public occlusionXBlur?: BlurGeometry;
  public occlusionYBlur?: BlurGeometry;
  public copyPickBuffers?: CopyPickBufferGeometry;
  public clearTranslucent?: ViewportQuadGeometry;
  public clearPickAndColor?: ViewportQuadGeometry;

  public collectStatistics(stats: RenderMemory.Statistics): void {
    collectGeometryStatistics(this.composite, stats);
    collectGeometryStatistics(this.volClassColorStencil, stats);
    collectGeometryStatistics(this.volClassCopyZ, stats);
    collectGeometryStatistics(this.volClassSetBlend, stats);
    collectGeometryStatistics(this.volClassBlend, stats);
    collectGeometryStatistics(this.occlusion, stats);
    collectGeometryStatistics(this.occlusionXBlur, stats);
    collectGeometryStatistics(this.occlusionYBlur, stats);
    collectGeometryStatistics(this.copyPickBuffers, stats);
    collectGeometryStatistics(this.clearTranslucent, stats);
    collectGeometryStatistics(this.clearPickAndColor, stats);
  }

  public init(textures: Textures): boolean {
    assert(undefined === this.composite);
    this.composite = CompositeGeometry.createGeometry(
      textures.color!.getHandle()!,
      textures.accumulation!.getHandle()!,
      textures.revealage!.getHandle()!, textures.hilite!.getHandle()!);

    if (undefined === this.composite)
      return false;

    assert(undefined === this.copyPickBuffers);

    this.copyPickBuffers = CopyPickBufferGeometry.createGeometry(textures.featureId!.getHandle()!, textures.depthAndOrder!.getHandle()!);
    this.clearTranslucent = ViewportQuadGeometry.create(TechniqueId.OITClearTranslucent);
    this.clearPickAndColor = ViewportQuadGeometry.create(TechniqueId.ClearPickAndColor);

    return undefined !== this.copyPickBuffers && undefined !== this.clearTranslucent && undefined !== this.clearPickAndColor;
  }

  public enableOcclusion(textures: Textures, depth: DepthBuffer): void {
    assert(undefined !== textures.occlusion && undefined !== textures.occlusionBlur && undefined !== textures.depthAndOrder && undefined !== textures.occlusionBlur);
    this.composite!.occlusion = textures.occlusion.getHandle();
    this.occlusion = AmbientOcclusionGeometry.createGeometry(textures.depthAndOrder.getHandle()!, depth.getHandle()!);
    this.occlusionXBlur = BlurGeometry.createGeometry(textures.occlusion.getHandle()!, textures.depthAndOrder.getHandle()!, undefined, new Vector2d(1.0, 0.0), BlurType.NoTest);
    const depthAndOrderHidden = (undefined === textures.depthAndOrderHidden ? textures.revealage?.getHandle() : textures.depthAndOrderHidden.getHandle());
    this.occlusionYBlur = BlurGeometry.createGeometry(textures.occlusionBlur.getHandle()!, textures.depthAndOrder.getHandle()!, depthAndOrderHidden, new Vector2d(0.0, 1.0), BlurType.TestOrder);
  }

  public disableOcclusion(): void {
    this.composite!.occlusion = undefined;
    this.occlusion = dispose(this.occlusion);
    this.occlusionXBlur = dispose(this.occlusionXBlur);
    this.occlusionYBlur = dispose(this.occlusionYBlur);
  }

  public enableVolumeClassifier(textures: Textures, depth: DepthBuffer): boolean {
    assert(undefined === this.volClassColorStencil && undefined === this.volClassCopyZ && undefined === this.volClassSetBlend && undefined === this.volClassBlend);
    this.volClassColorStencil = ViewportQuadGeometry.create(TechniqueId.VolClassColorUsingStencil);
    this.volClassCopyZ = SingleTexturedViewportQuadGeometry.createGeometry(depth.getHandle()!, TechniqueId.VolClassCopyZ);
    this.volClassSetBlend = VolumeClassifierGeometry.createVCGeometry(depth.getHandle()!);
    this.volClassBlend = SingleTexturedViewportQuadGeometry.createGeometry(textures.volClassBlend!.getHandle()!, TechniqueId.VolClassBlend);
    return undefined !== this.volClassColorStencil && undefined !== this.volClassCopyZ && undefined !== this.volClassSetBlend && undefined !== this.volClassBlend;
  }

  public disableVolumeClassifier(): void {
    if (undefined !== this.volClassColorStencil) {
      this.volClassColorStencil = dispose(this.volClassColorStencil);
      this.volClassCopyZ = dispose(this.volClassCopyZ);
      this.volClassSetBlend = dispose(this.volClassSetBlend);
      this.volClassBlend = dispose(this.volClassBlend);
    }
  }

  public get isDisposed(): boolean {
    return undefined === this.composite && undefined === this.occlusion && undefined === this.occlusionXBlur
      && undefined === this.occlusionYBlur && undefined === this.volClassColorStencil && undefined === this.volClassCopyZ
      && undefined === this.volClassSetBlend && undefined === this.volClassBlend && undefined === this.copyPickBuffers
      && undefined === this.clearTranslucent && undefined === this.clearPickAndColor;
  }

  public [Symbol.dispose]() {
    this.composite = dispose(this.composite);
    this.occlusion = dispose(this.occlusion);
    this.occlusionXBlur = dispose(this.occlusionXBlur);
    this.occlusionYBlur = dispose(this.occlusionYBlur);
    this.disableVolumeClassifier();
    this.copyPickBuffers = dispose(this.copyPickBuffers);
    this.clearTranslucent = dispose(this.clearTranslucent);
    this.clearPickAndColor = dispose(this.clearPickAndColor);
  }
}

interface BatchInfo {
  featureTable: RenderFeatureTable;
  iModel?: IModelConnection;
  transformFromIModel?: Transform;
  tileId?: string;
  viewAttachmentId?: Id64String;
  inSectionDrawingAttachment?: boolean;
}

interface ContourPixels {
  display: ContourDisplay;
  data: Uint32Array;
  zLow: number;
  zHigh: number;
}

// Represents a view of data read from a region of the frame buffer.
class PixelBuffer implements Pixel.Buffer {
  private readonly _rect: ViewRect;
  private readonly _selector: Pixel.Selector;
  private readonly _featureId?: Uint32Array;
  private readonly _depthAndOrder?: Uint32Array;
  private readonly _contours?: ContourPixels;
  private readonly _batchState: BatchState;
  private readonly _scratchModelFeature = ModelFeature.create();

  private get _numPixels(): number { return this._rect.width * this._rect.height; }

  private getPixelIndex(x: number, y: number): number {
    if (x < this._rect.left || y < this._rect.top)
      return this._numPixels;

    x -= this._rect.left;
    y -= this._rect.top;
    if (x >= this._rect.width || y >= this._rect.height)
      return this._numPixels;

    // NB: View coords have origin at top-left; GL at bottom-left. So our rows are upside-down.
    y = this._rect.height - 1 - y;
    return y * this._rect.width + x;
  }

  private getPixel32(data: Uint32Array, pixelIndex: number): number | undefined {
    return pixelIndex < data.length ? data[pixelIndex] : undefined;
  }

  private getFeature(pixelIndex: number, result: ModelFeature): ModelFeature | undefined {
    const featureId = this.getFeatureId(pixelIndex);
    return undefined !== featureId ? this._batchState.getFeature(featureId, result) : undefined;
  }

  private getFeatureId(pixelIndex: number): number | undefined {
    return undefined !== this._featureId ? this.getPixel32(this._featureId, pixelIndex) : undefined;
  }

  private getBatchInfo(pixelIndex: number): BatchInfo | undefined {
    const featureId = this.getFeatureId(pixelIndex);
    if (undefined !== featureId) {
      const batch = this._batchState.find(featureId);
      if (undefined !== batch) {
        return {
          featureTable: batch.featureTable,
          iModel: batch.batchIModel,
          transformFromIModel: batch.transformFromBatchIModel,
          tileId: batch.tileId,
          viewAttachmentId: batch.viewAttachmentId,
          inSectionDrawingAttachment: batch.inSectionDrawingAttachment,
        };
      }
    }

    return undefined;
  }

  private readonly _scratchUint32Array = new Uint32Array(1);
  private readonly _scratchUint8Array = new Uint8Array(this._scratchUint32Array.buffer);
  private readonly _scratchVector3d = new Vector3d();
  private readonly _mult = new Vector3d(1.0, 1.0 / 255.0, 1.0 / 65025.0);
  private decodeDepthRgba(depthAndOrder: number): number {
    this._scratchUint32Array[0] = depthAndOrder;
    const bytes = this._scratchUint8Array;
    const fpt = Vector3d.create(bytes[1] / 255.0, bytes[2] / 255.0, bytes[3] / 255.0, this._scratchVector3d);
    let depth = fpt.dotProduct(this._mult);

    assert(0.0 <= depth);
    assert(1.01 >= depth); // rounding error...

    depth = Math.min(1.0, depth);
    depth = Math.max(0.0, depth);

    return depth;
  }

  private decodeRenderOrderRgba(depthAndOrder: number): RenderOrder { return this.decodeUint8(depthAndOrder, 16); }
  private decodeUint8(rgba32: number, basis: number): number {
    this._scratchUint32Array[0] = rgba32;
    const encByte = this._scratchUint8Array[0];
    const enc = encByte / 255.0;
    const dec = Math.floor(basis * enc + 0.5);
    return dec;
  }


  private readonly _invalidPixelData = new Pixel.Data();
  public getPixel(x: number, y: number): Pixel.Data {
    const px = this._invalidPixelData;
    const index = this.getPixelIndex(x, y);
    if (index >= this._numPixels)
      return px;

    // Initialize to the defaults...
    let distanceFraction = px.distanceFraction;
    let geometryType = px.type;
    let planarity = px.planarity;

    const haveFeatureIds = Pixel.Selector.None !== (this._selector & Pixel.Selector.Feature);
    const feature = haveFeatureIds ? this.getFeature(index, this._scratchModelFeature) : undefined;
    const batchInfo = haveFeatureIds ? this.getBatchInfo(index) : undefined;
    if (Pixel.Selector.None !== (this._selector & Pixel.Selector.GeometryAndDistance) && undefined !== this._depthAndOrder) {
      const depthAndOrder = this.getPixel32(this._depthAndOrder, index);
      if (undefined !== depthAndOrder) {
        distanceFraction = this.decodeDepthRgba(depthAndOrder);

        const orderWithPlanarBit = this.decodeRenderOrderRgba(depthAndOrder);
        const order = orderWithPlanarBit & ~RenderOrder.PlanarBit;
        planarity = (orderWithPlanarBit === order) ? Pixel.Planarity.NonPlanar : Pixel.Planarity.Planar;
        switch (order) {
          case RenderOrder.None:
            geometryType = Pixel.GeometryType.None;
            planarity = Pixel.Planarity.None;
            break;
          case RenderOrder.Background:
          case RenderOrder.BlankingRegion:
          case RenderOrder.LitSurface:
          case RenderOrder.UnlitSurface:
            geometryType = Pixel.GeometryType.Surface;
            break;
          case RenderOrder.Linear:
            geometryType = Pixel.GeometryType.Linear;
            break;
          case RenderOrder.Edge:
            geometryType = Pixel.GeometryType.Edge;
            break;
          case RenderOrder.Silhouette:
            geometryType = Pixel.GeometryType.Silhouette;
            break;
          default:
            // ###TODO: may run into issues with point clouds - they are not written correctly in C++.
            assert(false, "Invalid render order");
            geometryType = Pixel.GeometryType.None;
            planarity = Pixel.Planarity.None;
            break;
        }
      }
    }

    let contour: ContourHit | undefined;
    if (this._contours) {
      const contour32 = this.getPixel32(this._contours.data, index);
      if (contour32) { // undefined means out of bounds; zero means not a contour.
        const groupIndexAndType = this.decodeUint8(contour32, 32);
        const groupIndex = groupIndexAndType & ~(8 | 16);
        const group = this._contours.display.groups[groupIndex];
        if (group) {
          const elevationFraction = this.decodeDepthRgba(contour32);
          let elevation = elevationFraction * (this._contours.zHigh - this._contours.zLow) + this._contours.zLow;
          // The shader rounds to the nearest contour elevation using single-precision arithmetic.
          // Re-round here using double-precision to get closer.
          const interval = group.contourDef.minorInterval;
          elevation = (elevation >= 0 ? Math.floor((elevation + interval / 2) / interval) : Math.ceil((elevation - interval / 2) / interval)) * interval;
          contour = {
            group,
            elevation,
            isMajor: groupIndexAndType > 15,
          };
        }
      }

    }

    let featureTable, iModel, transformToIModel, tileId, viewAttachmentId, inSectionDrawingAttachment;
    if (undefined !== batchInfo) {
      featureTable = batchInfo.featureTable;
      iModel = batchInfo.iModel;
      transformToIModel = batchInfo.transformFromIModel;
      tileId = batchInfo.tileId;
      viewAttachmentId = batchInfo.viewAttachmentId;
      inSectionDrawingAttachment = batchInfo.inSectionDrawingAttachment;
    }

    return new Pixel.Data({
      feature,
      distanceFraction,
      type: geometryType,
      planarity,
      batchType: featureTable?.type,
      iModel,
      transformFromIModel: transformToIModel,
      tileId,
      viewAttachmentId,
      inSectionDrawingAttachment,
      contour,
    });
  }

  private constructor(rect: ViewRect, selector: Pixel.Selector, compositor: SceneCompositor) {
    this._rect = rect.clone();
    this._selector = selector;
    this._batchState = compositor.target.uniforms.batch.state;

    if (Pixel.Selector.None !== (selector & Pixel.Selector.GeometryAndDistance)) {
      const depthAndOrderBytes = compositor.readDepthAndOrder(rect);
      if (undefined !== depthAndOrderBytes)
        this._depthAndOrder = new Uint32Array(depthAndOrderBytes.buffer);
      else
        this._selector &= ~Pixel.Selector.GeometryAndDistance;
    }

    if (Pixel.Selector.None !== (selector & Pixel.Selector.Feature)) {
      const features = compositor.readFeatureIds(rect);
      if (undefined !== features)
        this._featureId = new Uint32Array(features.buffer);
      else
        this._selector &= ~Pixel.Selector.Feature;
    }

    // Note: readContours is a no-op unless contours are actually being drawn.
    if (Pixel.Selector.None !== (selector & Pixel.Selector.Contours)) {
      this._contours = compositor.readContours(rect);
    }
  }

  public get isEmpty(): boolean { return Pixel.Selector.None === this._selector; }

  public static create(rect: ViewRect, selector: Pixel.Selector, compositor: SceneCompositor): Pixel.Buffer | undefined {
    const pdb = new PixelBuffer(rect, selector, compositor);
    return pdb.isEmpty ? undefined : pdb;
  }
}

/** Orchestrates rendering of the scene on behalf of a Target.
 * This base class exists only so we don't have to export all the types of the shared Compositor members like Textures, FrameBuffers, etc.
 * @internal
 */
export abstract class SceneCompositor implements WebGLDisposable, RenderMemory.Consumer {
  public readonly target: Target;
  public readonly solarShadowMap: SolarShadowMap;
  public readonly eyeDomeLighting: EyeDomeLighting;

  protected _needHiddenEdges: boolean;

  public abstract get isDisposed(): boolean;
  public abstract [Symbol.dispose](): void;
  public abstract preDraw(): void;
  public abstract draw(_commands: RenderCommands): void;
  public abstract drawForReadPixels(_commands: RenderCommands, sceneOverlays: GraphicList, worldOverlayDecorations: GraphicList | undefined, viewOverlayDecorations: GraphicList | undefined): void;
  public abstract readPixels(rect: ViewRect, selector: Pixel.Selector): Pixel.Buffer | undefined;
  public abstract readDepthAndOrder(rect: ViewRect): Uint8Array | undefined;
  public abstract readContours(rect: ViewRect): ContourPixels | undefined;
  public abstract readFeatureIds(rect: ViewRect): Uint8Array | undefined;
  public abstract updateSolarShadows(context: SceneContext | undefined): void;
  public abstract drawPrimitive(primitive: Primitive, exec: ShaderProgramExecutor, outputsToPick: boolean): void;
  public abstract forceBufferChange(): void;

  /** Obtain a framebuffer with a single spare RGBA texture that can be used for screen-space effect shaders. */
  public abstract get screenSpaceEffectFbo(): FrameBuffer;

  public abstract get featureIds(): TextureHandle;
  public abstract get depthAndOrder(): TextureHandle;
  public abstract get antialiasSamples(): number;

  public get needHiddenEdges(): boolean { return this._needHiddenEdges; }

  protected constructor(target: Target) {
    this.target = target;
    this.solarShadowMap = new SolarShadowMap(target);
    this.eyeDomeLighting = new EyeDomeLighting(target);
    this._needHiddenEdges = false;
  }

  public static create(target: Target): SceneCompositor {
    return new Compositor(target);
  }

  public abstract collectStatistics(stats: RenderMemory.Statistics): void;
}

// This describes what types of primitives a compositor should draw. See the `drawPrimitive` method of Compositor.
enum PrimitiveDrawState {
  Both,
  Pickable,
  NonPickable,
}

// The actual base class. Specializations are provided based on whether or not multiple render targets are supported.
class Compositor extends SceneCompositor {
  protected _width: number = -1;
  protected _height: number = -1;
  protected _includeOcclusion: boolean = false;
  protected _textures = new Textures();
  protected _depth?: DepthBuffer;
  protected _depthMS?: DepthBuffer; // multisample depth buffer
  protected _fbos: FrameBuffers;
  protected _geom: Geometry;
  protected _readPickDataFromPingPong: boolean = true;
  protected _opaqueRenderState = new RenderState();
  protected _layerRenderState = new RenderState();
  protected _translucentRenderState = new RenderState();
  protected _hiliteRenderState = new RenderState();
  protected _noDepthMaskRenderState = new RenderState();
  protected _backgroundMapRenderState = new RenderState();
  protected _pointCloudRenderState = new RenderState();
  protected _debugStencil: number = 0; // 0 to draw stencil volumes normally, 1 to draw as opaque, 2 to draw blended
  protected _vcBranchState?: BranchState;
  protected _vcSetStencilRenderState?: RenderState;
  protected _vcCopyZRenderState?: RenderState;
  protected _vcColorRenderState?: RenderState;
  protected _vcBlendRenderState?: RenderState;
  protected _vcPickDataRenderState?: RenderState;
  protected _vcDebugRenderState?: RenderState;
  protected _vcAltDepthStencil?: DepthBuffer;
  protected _vcAltDepthStencilMS?: DepthBuffer;
  protected _haveVolumeClassifier: boolean = false;
  protected _antialiasSamples: number = 1;
  protected readonly _viewProjectionMatrix = new Matrix4();
  protected _primitiveDrawState = PrimitiveDrawState.Both; // used by drawPrimitive to decide whether a primitive needs to be drawn.

  public forceBufferChange(): void { this._width = this._height = -1; }
  public get featureIds(): TextureHandle { return this.getSamplerTexture(this._readPickDataFromPingPong ? 0 : 1); }
  public get depthAndOrder(): TextureHandle { return this.getSamplerTexture(this._readPickDataFromPingPong ? 1 : 2); }
  private get _samplerFbo(): FrameBuffer { return this._readPickDataFromPingPong ? this._fbos.pingPong! : this._fbos.opaqueAll!; }
  private getSamplerTexture(index: number) { return this._samplerFbo.getColor(index); }

  public drawPrimitive(primitive: Primitive, exec: ShaderProgramExecutor, outputsToPick: boolean) {
    if ((outputsToPick && this._primitiveDrawState !== PrimitiveDrawState.NonPickable) ||
      (!outputsToPick && this._primitiveDrawState !== PrimitiveDrawState.Pickable))
      primitive.draw(exec);
  }

  protected clearOpaque(needComposite: boolean): void {
    const fbo = needComposite ? this._fbos.opaqueAndCompositeAll! : this._fbos.opaqueAll!;
    const system = System.instance;
    system.frameBufferStack.execute(fbo, true, this.useMsBuffers, () => {
      // Clear pick data buffers to 0's and color buffer to background color
      // (0,0,0,0) in elementID0 and ElementID1 buffers indicates invalid element id
      // (0,0,0,0) in DepthAndOrder buffer indicates render order 0 and encoded depth of 0 (= far plane)
      system.applyRenderState(this._noDepthMaskRenderState);
      const params = getDrawParams(this.target, this._geom.clearPickAndColor!);
      this.target.techniques.draw(params);

      // Clear depth buffer
      system.applyRenderState(RenderState.defaults); // depthMask == true.
      system.context.clearDepth(1.0);
      system.context.clear(GL.BufferBit.Depth);
    });
  }

  protected renderLayers(commands: RenderCommands, needComposite: boolean, pass: RenderPass): void {
    const fbo = (needComposite ? this._fbos.opaqueAndCompositeAll! : this._fbos.opaqueAll!);
    const useMsBuffers = RenderPass.OpaqueLayers === pass && fbo.isMultisampled && this.useMsBuffers;
    this._readPickDataFromPingPong = !useMsBuffers;
    System.instance.frameBufferStack.execute(fbo, true, useMsBuffers, () => {
      this.drawPass(commands, pass, true);
    });

    this._readPickDataFromPingPong = false;
  }

  protected renderOpaque(commands: RenderCommands, compositeFlags: CompositeFlags, renderForReadPixels: boolean) {
    if (CompositeFlags.None !== (compositeFlags & CompositeFlags.AmbientOcclusion) && !renderForReadPixels) {
      this.renderOpaqueAO(commands);
      return;
    }
    const needComposite = CompositeFlags.None !== compositeFlags;
    const fbStack = System.instance.frameBufferStack;

    // Output the first 2 passes to color and pick data buffers. (All 3 in the case of rendering for readPixels() or ambient occlusion).
    let fbo = (needComposite ? this._fbos.opaqueAndCompositeAll! : this._fbos.opaqueAll!);
    const useMsBuffers = fbo.isMultisampled && this.useMsBuffers;
    this._readPickDataFromPingPong = !useMsBuffers; // if multisampling then can read pick textures directly.
    fbStack.execute(fbo, true, useMsBuffers, () => {
      this.drawPass(commands, RenderPass.OpaqueLinear);
      this.drawPass(commands, RenderPass.OpaquePlanar, true);
      if (renderForReadPixels) {
        this.drawPass(commands, RenderPass.PointClouds, true); // don't need EDL for this
        this.drawPass(commands, RenderPass.OpaqueGeneral, true);
        if (useMsBuffers)
          fbo.blitMsBuffersToTextures(true);
      }
    });
    this._readPickDataFromPingPong = false;

    // The general pass (and following) will not bother to write to pick buffers and so can read from the actual pick buffers.
    if (!renderForReadPixels) {
      fbo = (needComposite ? this._fbos.opaqueAndCompositeColor! : this._fbos.opaqueColor!);
      fbStack.execute(fbo, true, useMsBuffers, () => {
        this.drawPass(commands, RenderPass.OpaqueGeneral, false);
        this.drawPass(commands, RenderPass.HiddenEdge, false);
      });
      // assume we are done with MS at this point, so update the non-MS buffers
      if (useMsBuffers)
        fbo.blitMsBuffersToTextures(needComposite);
    }
  }

  protected renderOpaqueAO(commands: RenderCommands) {
    const fbStack = System.instance.frameBufferStack;
    const haveHiddenEdges = 0 !== commands.getCommands(RenderPass.HiddenEdge).length;

    // Output the linear, planar, and pickable surfaces to color and pick data buffers.
    let fbo = this._fbos.opaqueAndCompositeAll!;
    const useMsBuffers = fbo.isMultisampled && this.useMsBuffers;
    this._readPickDataFromPingPong = !useMsBuffers; // if multisampling then can read pick textures directly.
    fbStack.execute(fbo, true, useMsBuffers, () => {
      this.drawPass(commands, RenderPass.OpaqueLinear);
      this.drawPass(commands, RenderPass.OpaquePlanar, true);
      this._primitiveDrawState = PrimitiveDrawState.Pickable;
      this.drawPass(commands, RenderPass.OpaqueGeneral, true);
      this._primitiveDrawState = PrimitiveDrawState.Both;
      if (useMsBuffers)
        fbo.blitMsBuffersToTextures(true);
    });
    this._readPickDataFromPingPong = false;

    // Output the non-pickable surfaces and hidden edges to just the color buffer.
    fbo = this._fbos.opaqueAndCompositeColor!;
    fbStack.execute(fbo, true, useMsBuffers, () => {
      this._primitiveDrawState = PrimitiveDrawState.NonPickable;
      this.drawPass(commands, RenderPass.OpaqueGeneral, false);
      if (haveHiddenEdges)
        this.drawPass(commands, RenderPass.HiddenEdge, false);
      this._primitiveDrawState = PrimitiveDrawState.Both;
    });
    if (useMsBuffers)
      fbo.blitMsBuffersToTextures(true);

    // If there are no hidden edges, then we're done & can run the AO passes using the normal depthAndOrder texture.
    if (haveHiddenEdges) {
      // AO needs the pick data (orderAndDepth) for the hidden edges.  We don't want it in with the other pick data though since they are not pickable, so we will use other textures.
      // If not multisampling we will re-use the ping-pong/transparency textures since we are done with ping-ponging at this point and transparency happens later.
      // If multisampling then we will use the accumulation texture for featureIDs and a special texture for depthAndOrder since the revealage texture is not the right type for multisampling.
      // First we will need to copy what's in the pick buffers so far into the hidden pick buffers.
      System.instance.applyRenderState(this._noDepthMaskRenderState);
      fbo = (useMsBuffers ? this._fbos.pingPongMS! : this._fbos.pingPong!);
      fbStack.execute(fbo, true, useMsBuffers, () => {
        const params = getDrawParams(this.target, this._geom.copyPickBuffers!);
        this.target.techniques.draw(params);
      });
      if (useMsBuffers)
        fbo.blitMsBuffersToTextures(false, 1); // only want to blit the depth/order target
      // Now draw the hidden edges, using an fbo which places their depth/order into the hidden pick buffers.
      // Since we are not writing to the actual pick buffers we let this._readPickDataFromPingPong remain false.
      fbo = this._fbos.opaqueAndCompositeAllHidden!;
      this._primitiveDrawState = PrimitiveDrawState.Pickable;
      fbStack.execute(fbo, true, useMsBuffers, () => {
        this.drawPass(commands, RenderPass.HiddenEdge, false);
      });
      this._primitiveDrawState = PrimitiveDrawState.Both;
      if (useMsBuffers) {
        // Only want to blit the color and depth/order targets as the featureId target is not blit-able and will generate a GL error.
        fbo.blitMsBuffersToTextures(false, 0);
        fbo.blitMsBuffersToTextures(false, 2);
      }
      this._needHiddenEdges = false;
    }

    this._needHiddenEdges = haveHiddenEdges; // this will cause the alternate renderAndOrder texture with the hidden edges to be read for the 2nd AO blur pass.
    this.renderAmbientOcclusion();
    this._needHiddenEdges = false;
  }

  protected renderPointClouds(commands: RenderCommands, compositeFlags: CompositeFlags) {
    const is3d = FrustumUniformType.Perspective === this.target.uniforms.frustum.type;
    // separate individual point clouds and get their point cloud settings
    const pointClouds: Array<SinglePointCloudData> = [];
    let pcs: PointCloudDisplaySettings | undefined;
    const cmds = commands.getCommands(RenderPass.PointClouds);
    let curPC: SinglePointCloudData | undefined;
    let pushDepth = 0;
    for (const cmd of cmds) {
      if ("pushBranch" === cmd.opcode) { // should be first command
        ++pushDepth;
        if (pushDepth === 1) {
          pcs = cmd.branch.branch.realityModelDisplaySettings?.pointCloud;
          this.target.uniforms.realityModel.pointCloud.updateRange(cmd.branch.branch.realityModelRange,
            this.target, cmd.branch.localToWorldTransform, is3d);
          pointClouds.push(curPC = { pcs, cmds: [cmd] });
        } else {
          assert(undefined !== curPC);
          curPC.cmds.push(cmd);
        }
      } else {
        if ("popBranch" === cmd.opcode)
          --pushDepth;
        assert(undefined !== curPC);
        curPC.cmds.push(cmd);
      }
    }

    const needComposite = CompositeFlags.None !== compositeFlags;
    const fbo = (needComposite ? this._fbos.opaqueAndCompositeColor! : this._fbos.opaqueColor!);
    const useMsBuffers = fbo.isMultisampled && this.useMsBuffers;
    const system = System.instance;
    const fbStack = system.frameBufferStack;

    this._readPickDataFromPingPong = false;

    for (const pc of pointClouds) {
      pcs = pc.pcs;
      let edlOn = pcs?.edlMode !== "off" && is3d;
      if (edlOn) {
        if (undefined === this._textures.hilite)
          edlOn = false;
        else {
          // create fbo on fly if not present, or has changed (from MS)
          // ###TODO consider not drawing point clouds to MS buffers, at least if EDL, it isn't worth the overhead.
          //         would have to blit depth before draw, use depth for draw, then run shader to copy depth back to MSAA
          //         at end, wherever color buf changed (test alpha, else discard)
          //         this would also simplify this code considerably
          let drawColBufs;
          if (undefined !== this._fbos.edlDrawCol)
            drawColBufs = this._fbos.edlDrawCol.getColorTargets(useMsBuffers, 0);
          if (undefined === this._fbos.edlDrawCol || this._textures.hilite !== drawColBufs?.tex || this._textures.hiliteMsBuff !== drawColBufs.msBuf) {
            this._fbos.edlDrawCol = dispose(this._fbos.edlDrawCol);
            const filters = [GL.MultiSampling.Filter.Linear];
            if (useMsBuffers)
              this._fbos.edlDrawCol = FrameBuffer.create([this._textures.hilite], this._depth,
                useMsBuffers && this._textures.hiliteMsBuff ? [this._textures.hiliteMsBuff] : undefined, filters, this._depthMS);
            else
              this._fbos.edlDrawCol = FrameBuffer.create([this._textures.hilite], this._depth);
          }
          if (undefined === this._fbos.edlDrawCol)
            edlOn = false;
          else { // can draw EDL
            // first draw pointcloud to borrowed hilite texture(MS) and regular depth(MS) buffers
            fbStack.execute(this._fbos.edlDrawCol, true, useMsBuffers, () => {
              system.context.clearColor(0, 0, 0, 0);
              system.context.clear(GL.BufferBit.Color);
              system.applyRenderState(this.getRenderState(RenderPass.PointClouds));
              this.target.techniques.execute(this.target, pc.cmds, RenderPass.PointClouds);
            });
            if (useMsBuffers)
              this._fbos.edlDrawCol.blitMsBuffersToTextures(true, 0); // need to read the non-MS depth and hilite buffers

            // next process buffers to generate EDL (depth buffer is passed during init)
            this.target.beginPerfMetricRecord("Calc EDL");  // ### todo keep? (probably)
            const sts = this.eyeDomeLighting.draw({
              edlMode: pc.pcs?.edlMode === "full" ? EDLMode.Full : EDLMode.On,
              edlFilter: !!pcs?.edlFilter,
              useMsBuffers,
              inputTex: this._textures.hilite,
              curFbo: fbo,
            });
            this.target.endPerfMetricRecord();
            if (!sts) {
              edlOn = false;
            }
          }
        }
      }
      if (!edlOn) {
        // draw the regular way
        fbStack.execute(fbo, true, useMsBuffers, () => {
          system.applyRenderState(this.getRenderState(RenderPass.PointClouds));
          this.target.techniques.execute(this.target, pc.cmds, RenderPass.PointClouds);
        });
      }
    }
  }

  protected renderForVolumeClassification(commands: RenderCommands, compositeFlags: CompositeFlags, renderForReadPixels: boolean) {
    const needComposite = CompositeFlags.None !== compositeFlags;
    const needAO = CompositeFlags.None !== (compositeFlags & CompositeFlags.AmbientOcclusion);
    const fbStack = System.instance.frameBufferStack;

    if (renderForReadPixels || needAO) {
      this._readPickDataFromPingPong = true;
      fbStack.execute(needComposite ? this._fbos.opaqueAndCompositeAll! : this._fbos.opaqueAll!, true, this.useMsBuffers, () => {
        this.drawPass(commands, RenderPass.OpaqueGeneral, true, RenderPass.VolumeClassifiedRealityData);
      });
    } else {
      this._readPickDataFromPingPong = false;
      fbStack.execute(needComposite ? this._fbos.opaqueAndCompositeColor! : this._fbos.opaqueColor!, true, this.useMsBuffers, () => {
        this.drawPass(commands, RenderPass.OpaqueGeneral, false, RenderPass.VolumeClassifiedRealityData);
      });
    }
  }

  protected renderIndexedClassifierForReadPixels(cmds: DrawCommands, state: RenderState, renderForIntersectingVolumes: boolean, needComposite: boolean) {
    this._readPickDataFromPingPong = true;
    const fbo = (renderForIntersectingVolumes ? (needComposite ? this._fbos.idsAndZComposite! : this._fbos.idsAndZ!)
      : (needComposite ? this._fbos.idsAndAltZComposite! : this._fbos.idsAndAltZ!));
    System.instance.frameBufferStack.execute(fbo, true, false, () => {
      System.instance.applyRenderState(state);
      this.target.techniques.execute(this.target, cmds, RenderPass.OpaqueGeneral);
    });
    this._readPickDataFromPingPong = false;
  }

  protected clearTranslucent() {
    System.instance.applyRenderState(this._noDepthMaskRenderState);
    System.instance.frameBufferStack.execute(this._fbos.clearTranslucent!, true, false, () => {
      const params = getDrawParams(this.target, this._geom.clearTranslucent!);
      this.target.techniques.draw(params);
    });
  }

  protected renderTranslucent(commands: RenderCommands) {
    System.instance.frameBufferStack.execute(this._fbos.translucent!, true, false, () => {
      this.drawPass(commands, RenderPass.Translucent);
    });
  }

  protected getBackgroundFbo(needComposite: boolean): FrameBuffer {
    return needComposite ? this._fbos.opaqueAndCompositeColor! : this._fbos.opaqueColor!;
  }

  protected pingPong() {
    if (this._fbos.opaqueAll!.isMultisampled && this.useMsBuffers) {
      // If we are multisampling we can just blit the FeatureId and DepthAndOrder MS buffers to their textures.
      this._fbos.opaqueAll!.blitMsBuffersToTextures(false, 1);
      this._fbos.opaqueAll!.blitMsBuffersToTextures(false, 2);
    } else {
      System.instance.applyRenderState(this._noDepthMaskRenderState);
      System.instance.frameBufferStack.execute(this._fbos.pingPong!, true, this.useMsBuffers, () => {
        const params = getDrawParams(this.target, this._geom.copyPickBuffers!);
        this.target.techniques.draw(params);
      });
    }
  }

  public get antialiasSamples(): number { return this._antialiasSamples; }

  protected get useMsBuffers(): boolean { return this._antialiasSamples > 1 && !this.target.isReadPixelsInProgress; }

  protected enableVolumeClassifierFbos(textures: Textures, depth: DepthBuffer, volClassDepth: DepthBuffer | undefined, depthMS?: DepthBuffer, volClassDepthMS?: DepthBuffer): void {
    this._fbos.enableVolumeClassifier(textures, depth, volClassDepth, depthMS, volClassDepthMS);
  }

  protected disableVolumeClassifierFbos(): void {
    this._fbos.disableVolumeClassifier();
  }

  /** This function generates a texture that contains ambient occlusion information to be applied later. */
  protected renderAmbientOcclusion() {
    const system = System.instance;

    // Render unblurred ambient occlusion based on depth buffer
    let fbo = this._fbos.occlusion!;
    this.target.beginPerfMetricRecord("Compute AO");
    system.frameBufferStack.execute(fbo, true, false, () => {
      System.instance.applyRenderState(RenderState.defaults);
      const params = getDrawParams(this.target, this._geom.occlusion!);
      this.target.techniques.draw(params);
    });
    this.target.endPerfMetricRecord();

    // Render the X-blurred ambient occlusion based on unblurred ambient occlusion
    fbo = this._fbos.occlusionBlur!;
    this.target.beginPerfMetricRecord("Blur AO X");
    system.frameBufferStack.execute(fbo, true, false, () => {
      System.instance.applyRenderState(RenderState.defaults);
      const params = getDrawParams(this.target, this._geom.occlusionXBlur!);
      this.target.techniques.draw(params);
    });
    this.target.endPerfMetricRecord();

    // Render the Y-blurred ambient occlusion based on X-blurred ambient occlusion (render into original occlusion framebuffer)
    fbo = this._fbos.occlusion!;
    this.target.beginPerfMetricRecord("Blur AO Y");
    system.frameBufferStack.execute(fbo, true, false, () => {
      System.instance.applyRenderState(RenderState.defaults);
      const params = getDrawParams(this.target, this._geom.occlusionYBlur!);
      this.target.techniques.draw(params);
    });
    this.target.endPerfMetricRecord();
  }

  public constructor(target: Target) {
    super(target);
    this._fbos = new FrameBuffers();
    this._geom = new Geometry();

    this._opaqueRenderState.flags.depthTest = true;

    this._pointCloudRenderState.flags.depthTest = true;

    this._translucentRenderState.flags.depthMask = false;
    this._translucentRenderState.flags.blend = this._translucentRenderState.flags.depthTest = true;
    this._translucentRenderState.blend.setBlendFuncSeparate(GL.BlendFactor.One, GL.BlendFactor.Zero, GL.BlendFactor.One, GL.BlendFactor.OneMinusSrcAlpha);

    this._hiliteRenderState.flags.depthMask = false;
    this._hiliteRenderState.flags.blend = true;
    this._hiliteRenderState.blend.functionDestRgb = GL.BlendFactor.One;
    this._hiliteRenderState.blend.functionDestAlpha = GL.BlendFactor.One;

    this._noDepthMaskRenderState.flags.depthMask = false;

    // Background map supports transparency, even when depth is off, which is mostly useless but should blend with background color / skybox.
    this._backgroundMapRenderState.flags.depthMask = false;
    this._backgroundMapRenderState.flags.blend = true;
    this._backgroundMapRenderState.blend.setBlendFunc(GL.BlendFactor.One, GL.BlendFactor.OneMinusSrcAlpha);

    // Can't write depth without enabling depth test - so make depth test always pass
    this._layerRenderState.flags.depthTest = true;
    this._layerRenderState.depthFunc = GL.DepthFunc.Always;
    this._layerRenderState.blend.setBlendFunc(GL.BlendFactor.One, GL.BlendFactor.OneMinusSrcAlpha);
  }

  public collectStatistics(stats: RenderMemory.Statistics): void {
    if (undefined !== this._depth)
      stats.addTextureAttachment(this._depth.bytesUsed);
    if (undefined !== this._depthMS)
      stats.addTextureAttachment(this._depthMS.bytesUsed);
    this._textures.collectStatistics(stats);
    this._geom.collectStatistics(stats);
  }

  public preDraw(): boolean {
    const rect = this.target.viewRect;
    const width = rect.width;
    const height = rect.height;
    const includeOcclusion = this.target.wantAmbientOcclusion;
    const wantVolumeClassifier = (undefined !== this.target.activeVolumeClassifierProps);
    let wantAntialiasSamples = this.target.antialiasSamples <= 1 ? 1 : this.target.antialiasSamples;
    if (wantAntialiasSamples > System.instance.maxAntialiasSamples)
      wantAntialiasSamples = System.instance.maxAntialiasSamples;

    const changeAntialiasSamples = (this._antialiasSamples > 1 && wantAntialiasSamples > 1 && this._antialiasSamples !== wantAntialiasSamples);

    // If not yet initialized, or dimensions changed, or antialiasing changed the number of samples, initialize.
    if (undefined === this._textures.accumulation || width !== this._width || height !== this._height || changeAntialiasSamples) {
      this._width = width;
      this._height = height;
      this._antialiasSamples = wantAntialiasSamples;

      // init() first calls dispose(), which releases all of our fbos, textures, etc, and resets the _includeOcclusion flag.
      if (!this.init()) {
        assert(false, "Failed to initialize scene compositor");
        return false;
      }
    } else if (this._antialiasSamples !== wantAntialiasSamples) {
      // Turn on or off multisampling.  Rather than just re-initializing, we can save the
      // non multisampled textures & FBOs and just try to add or delete the multisampled ones.
      this._antialiasSamples = wantAntialiasSamples;
      if (wantVolumeClassifier && this._haveVolumeClassifier) {
        // Multisampling and volume classification buffers are somewhat co-dependent so if volume classification is on
        // and is staying on, just disable volume classifiers and let them get re-enabled later.
        this.disableVolumeClassifierFbos();
        this._geom.disableVolumeClassifier();
        this._textures.disableVolumeClassifier();
        if (undefined !== this._vcAltDepthStencil) {
          this._vcAltDepthStencil[Symbol.dispose]();
          this._vcAltDepthStencil = undefined;
        }
        this._haveVolumeClassifier = false;
      }
      if (includeOcclusion && this._includeOcclusion) {
        // Multisampling and AO buffers are also somewhat co-dependent, so if AO is on
        // and is staying on, just disable AO and let it get re-enabled later.
        this._geom.disableOcclusion();
        this._fbos.disableOcclusion();
        this._textures.disableOcclusion();
        this._includeOcclusion = false;
      }
      if (this._antialiasSamples > 1) {
        if (!this.enableMultiSampling()) {
          assert(false, "Failed to initialize multisampling buffers");
          return false;
        }
      } else {
        if (!this.disableMultiSampling()) {
          assert(false, "Failed to initialize multisampling buffers");
          return false;
        }
      }
    }

    // Allocate or free ambient occlusion-related resources if necessary
    if (includeOcclusion !== this._includeOcclusion) {
      this._includeOcclusion = includeOcclusion;
      if (includeOcclusion) {
        if (!this._textures.enableOcclusion(width, height, this._antialiasSamples)) {
          assert(false, "Failed to initialize occlusion textures");
          return false;
        }
        if (!this._fbos.enableOcclusion(this._textures, this._depth!, this._depthMS)) {
          assert(false, "Failed to initialize occlusion frame buffers");
          return false;
        }
        this._geom.enableOcclusion(this._textures, this._depth!);
      } else {
        this._geom.disableOcclusion();
        this._fbos.disableOcclusion();
        this._textures.disableOcclusion();
      }
    }

    // Allocate or free volume classifier-related resources if necessary.
    if (wantVolumeClassifier !== this._haveVolumeClassifier) {
      if (wantVolumeClassifier) {
        this._vcAltDepthStencil = System.instance.createDepthBuffer(width, height) as TextureHandle;
        if (undefined !== this._depthMS)
          this._vcAltDepthStencilMS = System.instance.createDepthBuffer(width, height, this._antialiasSamples) as TextureHandle;

        if (undefined === this._vcAltDepthStencil || (undefined !== this._depthMS && undefined === this._vcAltDepthStencilMS))
          return false;

        if (!this._textures.enableVolumeClassifier(width, height, this._antialiasSamples))
          return false;

        if (!this._geom.enableVolumeClassifier(this._textures, this._depth!))
          return false;

        this.enableVolumeClassifierFbos(this._textures, this._depth!, this._vcAltDepthStencil, this._depthMS, this._vcAltDepthStencilMS);
        this._haveVolumeClassifier = true;
      } else {
        this.disableVolumeClassifierFbos();
        this._geom.disableVolumeClassifier();
        this._textures.disableVolumeClassifier();
        if (undefined !== this._vcAltDepthStencil) {
          this._vcAltDepthStencil[Symbol.dispose]();
          this._vcAltDepthStencil = undefined;
        }
        this._haveVolumeClassifier = false;
      }
    }

    return true;
  }

  public draw(commands: RenderCommands) {
    if (!this.preDraw())
      return;

    const compositeFlags = commands.compositeFlags;
    const needComposite = CompositeFlags.None !== compositeFlags;

    // Clear output targets
    this.target.frameStatsCollector.beginTime("opaqueTime");
    this.target.beginPerfMetricRecord("Clear Opaque");
    this.clearOpaque(needComposite);
    this.target.endPerfMetricRecord();
    this.target.frameStatsCollector.endTime("opaqueTime");

    this.target.frameStatsCollector.beginTime("backgroundTime"); // includes skybox

    // Render the background
    this.target.beginPerfMetricRecord("Render Background");
    this.renderBackground(commands, needComposite);
    this.target.endPerfMetricRecord();

    // Render the sky box
    this.target.beginPerfMetricRecord("Render Skybox");
    this.renderSkyBox(commands, needComposite);
    this.target.endPerfMetricRecord();

    // Render the background map graphics
    this.target.beginPerfMetricRecord("Render Background Map");
    this.renderBackgroundMap(commands, needComposite);
    this.target.endPerfMetricRecord();

    this.target.frameStatsCollector.endTime("backgroundTime");

    // Enable clipping
    this.target.beginPerfMetricRecord("Enable Clipping");
    this.target.pushViewClip();
    this.target.endPerfMetricRecord();

    // Render volume classification first so that we only classify the reality data
    this.target.frameStatsCollector.beginTime("classifiersTime");
    this.target.beginPerfMetricRecord("Render VolumeClassification");
    this.renderVolumeClassification(commands, compositeFlags, false);
    this.target.endPerfMetricRecord();
    this.target.frameStatsCollector.endTime("classifiersTime");

    this.target.frameStatsCollector.beginTime("opaqueTime");

    // Render layers
    this.target.beginPerfMetricRecord("Render Opaque Layers");
    this.renderLayers(commands, needComposite, RenderPass.OpaqueLayers);
    this.target.endPerfMetricRecord();

    // Render opaque geometry
    this.target.frameStatsCollector.beginTime("onRenderOpaqueTime");
    IModelFrameLifecycle.onRenderOpaque.raiseEvent({
      commands,
      needComposite,
      compositeFlags,
      fbo: this.getBackgroundFbo(needComposite),
      frameBufferStack: System.instance.frameBufferStack,
    });
    this.target.frameStatsCollector.endTime("onRenderOpaqueTime");

    // Render point cloud geometry with possible EDL
    this.target.beginPerfMetricRecord("Render PointClouds");
    this.renderPointClouds(commands, compositeFlags);
    this.target.endPerfMetricRecord();

    // Render opaque geometry
    this.target.beginPerfMetricRecord("Render Opaque");
    this.renderOpaque(commands, compositeFlags, false);
    this.target.endPerfMetricRecord();

    this.target.frameStatsCollector.endTime("opaqueTime");

    this.target.frameStatsCollector.beginTime("translucentTime");

    // Render translucent layers
    this.target.beginPerfMetricRecord("Render Translucent Layers");
    this.renderLayers(commands, needComposite, RenderPass.TranslucentLayers);
    this.target.endPerfMetricRecord();

    if (needComposite) {
      this._geom.composite!.update(compositeFlags);
      this.target.beginPerfMetricRecord("Render Translucent");
      this.clearTranslucent();
      this.renderTranslucent(commands);
      this.target.endPerfMetricRecord();

      this.target.frameStatsCollector.endTime("translucentTime");

      this.target.beginPerfMetricRecord("Render Hilite");
      this.renderHilite(commands);
      this.target.endPerfMetricRecord();

      this.target.beginPerfMetricRecord("Composite");
      this.composite();
      this.target.endPerfMetricRecord();
    } else
      this.target.frameStatsCollector.endTime("translucentTime");

    // Render overlay Layers
    this.target.frameStatsCollector.beginTime("overlaysTime");
    this.target.beginPerfMetricRecord("Render Overlay Layers");
    this.renderLayers(commands, false, RenderPass.OverlayLayers);
    this.target.endPerfMetricRecord();
    this.target.frameStatsCollector.endTime("overlaysTime");

    this.target.popViewClip();
  }

  public get fullHeight(): number { return this.target.viewRect.height; }

  public drawForReadPixels(commands: RenderCommands, sceneOverlays: GraphicList, worldOverlayDecorations: GraphicList | undefined, viewOverlayDecorations: GraphicList | undefined): void {
    this.target.beginPerfMetricRecord("Render Background", true);
    if (!this.preDraw()) {
      this.target.endPerfMetricRecord(true); // End Render Background record if returning
      assert(false);
      return;
    }

    this.clearOpaque(false);
    this.target.endPerfMetricRecord(true);

    // On entry the RenderCommands has been initialized for all scene graphics and pickable decorations with the exception of world overlays.
    // It's possible we have no pickable scene graphics or decorations, but do have pickable world overlays.
    const haveRenderCommands = !commands.isEmpty;
    if (haveRenderCommands) {
      this.target.beginPerfMetricRecord("Enable Clipping", true);
      this.target.pushViewClip();
      this.target.endPerfMetricRecord(true);

      this.target.beginPerfMetricRecord("Render VolumeClassification", true);
      this.renderVolumeClassification(commands, CompositeFlags.None, true);
      this.target.endPerfMetricRecord(true);

      // RenderPass.BackgroundMap is used only when depth is turned off for the map.
      // Ensure it draws before any opaque geometry (including layers), without depth.
      this.target.beginPerfMetricRecord("Render background map", true);
      this.target.drawingBackgroundForReadPixels = true;
      this.renderLayers(commands, false, RenderPass.BackgroundMap);
      this.target.drawingBackgroundForReadPixels = false;
      this.target.endPerfMetricRecord(true);

      this.target.beginPerfMetricRecord("Render Opaque Layers", true);
      this.renderLayers(commands, false, RenderPass.OpaqueLayers);
      this.target.endPerfMetricRecord(true);

      // PointClouds are rendered in Opaque pass for readPixels
      this.target.beginPerfMetricRecord("Render Opaque", true);
      this.renderOpaque(commands, CompositeFlags.None, true);
      this.target.endPerfMetricRecord(true);

      this.target.beginPerfMetricRecord("Render Translucent Layers", true);
      this.renderLayers(commands, false, RenderPass.TranslucentLayers);
      this.target.endPerfMetricRecord(true);

      this.target.beginPerfMetricRecord("Render Overlay Layers", true);
      this.renderLayers(commands, false, RenderPass.OverlayLayers);
      this.target.endPerfMetricRecord(true);

      this.target.popViewClip();
    }

    if (!sceneOverlays.length && !worldOverlayDecorations?.length && !viewOverlayDecorations?.length)
      return;

    // Now populate the opaque passes with any pickable world overlays
    this.target.beginPerfMetricRecord("Overlay Draws", true);
    commands.initForPickOverlays(sceneOverlays, worldOverlayDecorations, viewOverlayDecorations);
    if (commands.isEmpty) {
      this.target.endPerfMetricRecord(true); // End Overlay Draws record if returning
      return;
    }

    // Clear the depth buffer so that overlay decorations win the depth test.
    // (If *only* overlays exist, then clearOpaque() above already took care of this).
    if (haveRenderCommands) {
      const system = System.instance;
      system.frameBufferStack.execute(this._fbos.opaqueColor!, true, this.useMsBuffers, () => {
        system.applyRenderState(RenderState.defaults);
        system.context.clearDepth(1.0);
        system.context.clear(GL.BufferBit.Depth);
      });
    }

    // Render overlays as opaque into the pick buffers. Make sure we use the decoration state (to ignore symbology overrides, esp. the non-locatable flag).
    const decState = this.target.decorationsState;
    const vf = decState.viewFlags;
    if (vf.transparency)
      decState.viewFlags = vf.copy({ transparency: false });

    this.renderOpaque(commands, CompositeFlags.None, true);
    this.target.endPerfMetricRecord();
    decState.viewFlags = vf;
  }

  public readPixels(rect: ViewRect, selector: Pixel.Selector): Pixel.Buffer | undefined {
    return PixelBuffer.create(rect, selector, this);
  }

  public readDepthAndOrder(rect: ViewRect): Uint8Array | undefined {
    return this.readFrameBuffer(rect, this._fbos.depthAndOrder);
  }

  public override readContours(rect: ViewRect): ContourPixels | undefined {
    // Are we actually drawing any contours? If not, don't bother reading an array of all zeroes off the GPU.
    const contours = this.target.currentContours;
    if (!contours || !contours.displayContours || contours.groups.length === 0) {
      return undefined;
    }

    const info = this.readFrameBuffer(rect, this._fbos.contours);
    if (!info) {
      return undefined;
    }

    return {
      data: new Uint32Array(info.buffer),
      display: contours,
      zLow: this.target.uniforms.frustum.worldFrustumZRange[0],
      zHigh: this.target.uniforms.frustum.worldFrustumZRange[1],
    };
  }

  public readFeatureIds(rect: ViewRect): Uint8Array | undefined {
    const tex = this._textures.featureId;
    if (undefined === tex)
      return undefined;

    const fbo = FrameBuffer.create([tex]);
    const result = this.readFrameBuffer(rect, fbo);

    dispose(fbo);

    return result;
  }

  public updateSolarShadows(context: SceneContext | undefined): void {
    this.solarShadowMap.update(context);
  }

  public get screenSpaceEffectFbo(): FrameBuffer {
    assert(undefined !== this._fbos.hilite);
    return this._fbos.hilite;
  }

  private readFrameBuffer(rect: ViewRect, fbo?: FrameBuffer): Uint8Array | undefined {
    if (undefined === fbo || !Debug.isValidFrameBuffer)
      return undefined;

    // NB: ViewRect origin at top-left; GL origin at bottom-left
    const bottom = this.fullHeight - rect.bottom;
    const gl = System.instance.context;
    const bytes = new Uint8Array(rect.width * rect.height * 4);
    let result: Uint8Array | undefined = bytes;
    System.instance.frameBufferStack.execute(fbo, true, false, () => {
      try {
        gl.readPixels(rect.left, bottom, rect.width, rect.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      } catch {
        result = undefined;
      }
    });

    return result;
  }

  public get isDisposed(): boolean {
    return undefined === this._depth
      && undefined === this._vcAltDepthStencil
      && !this._includeOcclusion
      && this._textures.isDisposed
      && this._fbos.isDisposed
      && this._geom.isDisposed
      && !this._haveVolumeClassifier
      && this.solarShadowMap.isDisposed
      && this.eyeDomeLighting.isDisposed;
  }

  public [Symbol.dispose]() {
    this.reset();
    dispose(this.solarShadowMap);
    dispose(this.eyeDomeLighting);
  }

  // Resets anything that depends on the dimensions of the render target.
  // Does *not* dispose the solar shadow map.
  private reset() {
    this._depth = dispose(this._depth);
    this._depthMS = dispose(this._depthMS);
    this._vcAltDepthStencil = dispose(this._vcAltDepthStencil);
    this._includeOcclusion = false;
    dispose(this._textures);
    dispose(this._fbos);
    dispose(this._geom);
    this._haveVolumeClassifier = false;
    this.eyeDomeLighting.reset();
  }

  private init(): boolean {
    this.reset();
    this._depth = System.instance.createDepthBuffer(this._width, this._height, 1);
    if (this._antialiasSamples > 1)
      this._depthMS = System.instance.createDepthBuffer(this._width, this._height, this._antialiasSamples);
    else
      this._depthMS = undefined;
    if (this._depth !== undefined) {
      return this._textures.init(this._width, this._height, this._antialiasSamples)
        && this._fbos.init(this._textures, this._depth, this._depthMS)
        && this._geom.init(this._textures)
        && this.eyeDomeLighting.init(this._width, this._height, this._depth);
    }
    return false;
  }

  protected enableMultiSampling(): boolean {
    // Assume that non-multisampled stuff is already allocated.  Just need to add multisampled textures, buffers, & geometry.
    assert(undefined === this._depthMS && undefined !== this._depth);
    this._depthMS = System.instance.createDepthBuffer(this._width, this._height, this._antialiasSamples);
    if (undefined === this._depthMS)
      return false;

    if (!this._textures.enableMultiSampling(this._width, this._height, this._antialiasSamples))
      return false;

    assert(undefined !== this._depth && undefined !== this._depthMS);
    return this._fbos.enableMultiSampling(this._textures, this._depth, this._depthMS);
  }

  protected disableMultiSampling(): boolean {
    assert(undefined !== this._depth);
    if (!this._fbos.disableMultiSampling(this._textures, this._depth))
      return false;

    // Want to disable multisampling without deleting & reallocating other stuff.
    this._depthMS = dispose(this._depthMS);
    assert(undefined !== this._depth);
    return this._textures.disableMultiSampling();
  }

  private renderBackgroundMap(commands: RenderCommands, needComposite: boolean) {
    const cmds = commands.getCommands(RenderPass.BackgroundMap);
    if (0 === cmds.length) {
      return;
    }

    const fbStack = System.instance.frameBufferStack;
    const fbo = this.getBackgroundFbo(needComposite);
    fbStack.execute(fbo, true, this.useMsBuffers, () => {
      System.instance.applyRenderState(this.getRenderState(RenderPass.BackgroundMap));
      this.target.techniques.execute(this.target, cmds, RenderPass.BackgroundMap);
    });
  }

  private renderSkyBox(commands: RenderCommands, needComposite: boolean) {
    const cmds = commands.getCommands(RenderPass.SkyBox);
    if (0 === cmds.length) {
      return;
    }

    const fbStack = System.instance.frameBufferStack;
    const fbo = this.getBackgroundFbo(needComposite);
    fbStack.execute(fbo, true, this.useMsBuffers, () => {
      System.instance.applyRenderState(this.getRenderState(RenderPass.SkyBox));
      this.target.techniques.execute(this.target, cmds, RenderPass.SkyBox);
    });
  }

  private renderBackground(commands: RenderCommands, needComposite: boolean) {
    const cmds = commands.getCommands(RenderPass.Background);
    if (0 === cmds.length)
      return;

    const fbStack = System.instance.frameBufferStack;
    const fbo = this.getBackgroundFbo(needComposite);
    fbStack.execute(fbo, true, this.useMsBuffers, () => {
      System.instance.applyRenderState(this.getRenderState(RenderPass.Background));
      this.target.techniques.execute(this.target, cmds, RenderPass.Background);
    });
  }

  private createVolumeClassifierStates() {
    // If we have already created a branch state for use in rendering the volume classifiers we must at least swap out its symbology overrides for the current one.
    if (undefined !== this._vcBranchState) {
      this._vcBranchState.symbologyOverrides = this.target.uniforms.branch.top.symbologyOverrides;
      return;
    }

    // Create a BranchState and several RenderStates to use when drawing the classifier volumes.
    // The BranchState needs to be created every time in case the symbology overrides changes.
    // It is based off of the current state, but turns off unnecessary and unwanted options, lighting being the most important.
    const top = this.target.uniforms.branch.top;
    const viewFlags = top.viewFlags.copy({
      renderMode: RenderMode.SmoothShade,
      wiremesh: false,
      lighting: false,
      forceSurfaceDiscard: false,
      hiddenEdges: false,
      visibleEdges: false,
      materials: false,
      textures: false,
      transparency: false,
    });

    this._vcBranchState = new BranchState({
      symbologyOverrides: top.symbologyOverrides,
      viewFlags,
      transform: Transform.createIdentity(),
      clipVolume: top.clipVolume,
      planarClassifier: top.planarClassifier,
      iModel: top.iModel,
      is3d: top.is3d,
      edgeSettings: top.edgeSettings,
      contourLine: top.contourLine,
    });

    this._vcSetStencilRenderState = new RenderState();
    this._vcCopyZRenderState = new RenderState();
    this._vcColorRenderState = new RenderState();
    this._vcBlendRenderState = new RenderState();
    this._vcPickDataRenderState = new RenderState();

    this._vcCopyZRenderState.flags.depthTest = true;
    this._vcCopyZRenderState.flags.depthMask = true;
    this._vcCopyZRenderState.depthFunc = GL.DepthFunc.Always;
    this._vcCopyZRenderState.flags.colorWrite = true;
    this._vcCopyZRenderState.flags.stencilTest = true;
    this._vcCopyZRenderState.stencil.frontFunction.function = GL.StencilFunction.Always;
    this._vcCopyZRenderState.stencil.frontOperation.fail = GL.StencilOperation.Zero;
    this._vcCopyZRenderState.stencil.frontOperation.zFail = GL.StencilOperation.Zero;
    this._vcCopyZRenderState.stencil.frontOperation.zPass = GL.StencilOperation.Zero;
    this._vcCopyZRenderState.stencil.backFunction.function = GL.StencilFunction.Always;
    this._vcCopyZRenderState.stencil.backOperation.fail = GL.StencilOperation.Zero;
    this._vcCopyZRenderState.stencil.backOperation.zFail = GL.StencilOperation.Zero;
    this._vcCopyZRenderState.stencil.backOperation.zPass = GL.StencilOperation.Zero;

    this._vcSetStencilRenderState.flags.depthTest = true;
    this._vcSetStencilRenderState.flags.depthMask = false;
    this._vcSetStencilRenderState.flags.colorWrite = false;
    this._vcSetStencilRenderState.flags.stencilTest = true;
    this._vcSetStencilRenderState.depthFunc = GL.DepthFunc.LessOrEqual;
    this._vcSetStencilRenderState.stencil.frontFunction.function = GL.StencilFunction.Always;
    this._vcSetStencilRenderState.stencil.frontOperation.zFail = GL.StencilOperation.IncrWrap;
    this._vcSetStencilRenderState.stencil.backFunction.function = GL.StencilFunction.Always;
    this._vcSetStencilRenderState.stencil.backOperation.zFail = GL.StencilOperation.DecrWrap;

    this._vcPickDataRenderState.flags.depthTest = false;
    this._vcPickDataRenderState.flags.depthMask = false;
    this._vcPickDataRenderState.flags.colorWrite = true;
    this._vcPickDataRenderState.flags.stencilTest = true;
    this._vcPickDataRenderState.flags.cull = true;
    this._vcPickDataRenderState.cullFace = GL.CullFace.Front;
    this._vcPickDataRenderState.stencil.backFunction.function = GL.StencilFunction.NotEqual;
    this._vcPickDataRenderState.stencil.backOperation.zPass = GL.StencilOperation.Zero; // this will clear the stencil
    // Let all of the operations remain at Keep so that the stencil will remain in tact for the subsequent blend draw to the color buffer.

    this._vcColorRenderState.flags.depthTest = false;
    this._vcColorRenderState.flags.depthMask = false;
    this._vcColorRenderState.flags.colorWrite = true;
    this._vcColorRenderState.flags.stencilTest = true;
    this._vcColorRenderState.cullFace = GL.CullFace.Front;
    this._vcColorRenderState.stencil.frontFunction.function = GL.StencilFunction.NotEqual;
    this._vcColorRenderState.stencil.frontOperation.fail = GL.StencilOperation.Zero;
    this._vcColorRenderState.stencil.frontOperation.zFail = GL.StencilOperation.Zero;
    this._vcColorRenderState.stencil.frontOperation.zPass = GL.StencilOperation.Zero; // this will clear the stencil
    this._vcColorRenderState.stencil.backFunction.function = GL.StencilFunction.NotEqual;
    this._vcColorRenderState.stencil.backOperation.fail = GL.StencilOperation.Zero;
    this._vcColorRenderState.stencil.backOperation.zFail = GL.StencilOperation.Zero;
    this._vcColorRenderState.stencil.backOperation.zPass = GL.StencilOperation.Zero; // this will clear the stencil
    this._vcColorRenderState.flags.blend = true; // blend func and color will be set before using

    this._vcBlendRenderState.flags.depthTest = false;
    this._vcBlendRenderState.flags.depthMask = false;
    this._vcBlendRenderState.flags.colorWrite = true;
    this._vcBlendRenderState.flags.stencilTest = false;
    this._vcBlendRenderState.flags.blend = true;
    this._vcBlendRenderState.blend.setBlendFuncSeparate(GL.BlendFactor.SrcAlpha, GL.BlendFactor.Zero, GL.BlendFactor.OneMinusSrcAlpha, GL.BlendFactor.One);

    if (this._debugStencil > 0) {
      this._vcDebugRenderState = new RenderState();
      this._vcDebugRenderState.flags.depthTest = true;
      this._vcDebugRenderState.flags.blend = true;
      this._vcDebugRenderState.blend.setBlendFunc(GL.BlendFactor.OneMinusConstColor, GL.BlendFactor.ConstColor);
      this._vcDebugRenderState.blend.color = [0.67, 0.67, 0.67, 1.0];
    }
  }

  private setAllStencilOps(state: RenderState, op: GL.StencilOperation): void {
    state.stencil.frontOperation.fail = op;
    state.stencil.frontOperation.zFail = op;
    state.stencil.frontOperation.zPass = op;
    state.stencil.backOperation.fail = op;
    state.stencil.backOperation.zFail = op;
    state.stencil.backOperation.zPass = op;
  }

  private renderIndexedVolumeClassifier(cmdsByIndex: DrawCommands, needComposite: boolean) {
    // Set the stencil for the given classifier stencil volume.
    System.instance.frameBufferStack.execute(this._fbos.stencilSet!, false, this.useMsBuffers, () => {
      this.target.pushState(this._vcBranchState!);
      System.instance.applyRenderState(this._vcSetStencilRenderState!);
      this.target.techniques.executeForIndexedClassifier(this.target, cmdsByIndex, RenderPass.Classification);
      this.target.popBranch();
    });
    // Process the stencil for the pick data.
    this.renderIndexedClassifierForReadPixels(cmdsByIndex, this._vcPickDataRenderState!, true, needComposite);
  }

  private renderVolumeClassification(commands: RenderCommands, compositeFlags: CompositeFlags, renderForReadPixels: boolean) {
    // Sometimes we need to render the classifier stencil volumes one at a time, if so draw them from the cmdsByIndex list
    const cmds = commands.getCommands(RenderPass.Classification);
    const cmdsByIndex = commands.getCommands(RenderPass.ClassificationByIndex);
    let numCmdsPerClassifier = 0;
    for (const cmd of cmdsByIndex) { // Figure out how many commands there are per index/primitive
      numCmdsPerClassifier++;
      if ("drawPrimitive" === cmd.opcode) {
        numCmdsPerClassifier += numCmdsPerClassifier - 1;
        break;
      }
    }
    const cmdsForVC = commands.getCommands(RenderPass.VolumeClassifiedRealityData);
    if (!this.target.activeVolumeClassifierProps || (renderForReadPixels && 0 === cmds.length) || 0 === cmdsForVC.length)
      return;

    let outsideFlags = this.target.activeVolumeClassifierProps.flags.outside;
    let insideFlags = this.target.activeVolumeClassifierProps.flags.inside;

    if (this.target.wantThematicDisplay) {
      if (outsideFlags !== SpatialClassifierOutsideDisplay.Off)
        outsideFlags = SpatialClassifierOutsideDisplay.On;
      if (insideFlags !== SpatialClassifierInsideDisplay.Off)
        insideFlags = SpatialClassifierInsideDisplay.On;
    }

    // Render the geometry which we are going to classify.
    this.renderForVolumeClassification(commands, compositeFlags, renderForReadPixels);

    this.createVolumeClassifierStates();

    const fbStack = System.instance.frameBufferStack;
    const needComposite = CompositeFlags.None !== compositeFlags;
    const fboColorAndZ = this.getBackgroundFbo(needComposite);

    if (this._debugStencil > 0) {
      fbStack.execute(fboColorAndZ, true, this.useMsBuffers, () => {
        if (1 === this._debugStencil) {
          System.instance.applyRenderState(this.getRenderState(RenderPass.OpaqueGeneral));
          this.target.techniques.execute(this.target, cmds, RenderPass.OpaqueGeneral);
        } else {
          this.target.pushState(this._vcBranchState!);
          System.instance.applyRenderState(this._vcDebugRenderState!);
          this.target.techniques.execute(this.target, cmds, RenderPass.Classification);
          this.target.popBranch();
        }
      });
      return;
    }

    if (undefined === this._fbos.altZOnly || undefined === this._fbos.stencilSet)
      return;

    if (renderForReadPixels && this.target.vcSupportIntersectingVolumes) {
      // Clear the stencil.
      fbStack.execute(this._fbos.stencilSet, false, this.useMsBuffers, () => {
        System.instance.context.clearStencil(0);
        System.instance.context.clear(GL.BufferBit.Stencil);
      });

      if (this._antialiasSamples > 1 && undefined !== this._depthMS && this.useMsBuffers)
        this._fbos.stencilSet.blitMsBuffersToTextures(true, -1); // make sure that the Z buffer that we are about to read has been blitted

      for (let i = 0; i < cmdsByIndex.length; i += numCmdsPerClassifier)
        this.renderIndexedVolumeClassifier(cmdsByIndex.slice(i, i + numCmdsPerClassifier), needComposite);

      return;
    }

    const needOutsideDraw = SpatialClassifierOutsideDisplay.On !== outsideFlags;
    const needInsideDraw = SpatialClassifierInsideDisplay.On !== insideFlags;
    const doColorByElement = SpatialClassifierInsideDisplay.ElementColor === insideFlags || renderForReadPixels;
    const doColorByElementForIntersectingVolumes = this.target.vcSupportIntersectingVolumes;
    const needAltZ = (doColorByElement && !doColorByElementForIntersectingVolumes) || needOutsideDraw;
    let zOnlyFbo = this._fbos.stencilSet;
    let volClassBlendFbo = this._fbos.volClassCreateBlend;
    let volClassBlendReadZTexture = this._vcAltDepthStencil!.getHandle()!;
    let volClassBlendReadZTextureFbo = this._fbos.altZOnly;
    if (!needAltZ) {
      // Initialize the blend texture and the stencil.
      assert(undefined !== volClassBlendFbo);
      fbStack.execute(volClassBlendFbo, true, this.useMsBuffers, () => {
        System.instance.context.clearColor(0.0, 0.0, 0.0, 0.0);
        System.instance.context.clearStencil(0);
        System.instance.context.clear(GL.BufferBit.Color | GL.BufferBit.Stencil);
      });
    } else {
      // If we are doing color-by-element for the inside do not care about intersecting volumes or we need to color the outside
      // then we need to copy the Z buffer and set up a different zbuffer/stencil to render in.
      zOnlyFbo = this._fbos.altZOnly;
      volClassBlendFbo = this._fbos.volClassCreateBlendAltZ;
      assert(undefined !== volClassBlendFbo);
      volClassBlendReadZTexture = this._depth!.getHandle()!;
      volClassBlendReadZTextureFbo = this._fbos.stencilSet;
      if (this._antialiasSamples > 1 && undefined !== this._depthMS && this.useMsBuffers)
        volClassBlendReadZTextureFbo.blitMsBuffersToTextures(true, -1); // make sure that the Z buffer that we are about to read has been blitted
      // Copy the current Z into the Alt-Z.  At the same time go ahead and clear the stencil and the blend texture.
      fbStack.execute(volClassBlendFbo, true, this.useMsBuffers, () => {
        this.target.pushState(this.target.decorationsState);
        System.instance.applyRenderState(this._vcCopyZRenderState!);

        this.target.techniques.draw(getDrawParams(this.target, this._geom.volClassCopyZ!));  // This method uses the EXT_frag_depth extension

        System.instance.bindTexture2d(TextureUnit.Zero, undefined);
        this.target.popBranch();
      });
    }

    if (renderForReadPixels) {
      // Set the stencil for all of the classifier volumes.
      System.instance.frameBufferStack.execute(this._fbos.altZOnly, false, this.useMsBuffers, () => {
        this.target.pushState(this._vcBranchState!);
        System.instance.applyRenderState(this._vcSetStencilRenderState!);
        this.target.techniques.execute(this.target, cmds, RenderPass.Classification);
        // After we create the stencil we need to clear the Z for the next step (so also must turn on z writing temporarily).
        this._vcSetStencilRenderState!.flags.depthMask = true;
        System.instance.applyRenderState(this._vcSetStencilRenderState!);
        System.instance.context.clearDepth(1.0);
        System.instance.context.clear(GL.BufferBit.Depth);
        this._vcSetStencilRenderState!.flags.depthMask = false;
        this.target.popBranch();
        System.instance.bindTexture2d(TextureUnit.Two, undefined);
        System.instance.bindTexture2d(TextureUnit.Five, undefined);
      });
      this.target.pushState(this._vcBranchState!);
      this._vcColorRenderState!.flags.depthTest = true;
      this._vcColorRenderState!.flags.depthMask = true;
      this._vcColorRenderState!.flags.cull = true;
      this._vcColorRenderState!.flags.blend = false;
      this.setAllStencilOps(this._vcColorRenderState!, GL.StencilOperation.Keep); // don't clear the stencil so that all classifiers behind reality mesh will still draw
      this.target.activeVolumeClassifierTexture = this._geom.volClassCopyZ!.texture;
      if (this._antialiasSamples > 1 && undefined !== this._depthMS && this.useMsBuffers)
        this._fbos.stencilSet.blitMsBuffersToTextures(true, -1); // make sure that the Z buffer that we are about to read has been blitted
      this.renderIndexedClassifierForReadPixels(cmds, this._vcColorRenderState!, false, needComposite);
      this.target.activeVolumeClassifierTexture = undefined;
      this._vcColorRenderState!.flags.depthTest = false;
      this._vcColorRenderState!.flags.depthMask = false;
      this._vcColorRenderState!.flags.cull = false;
      this._vcColorRenderState!.flags.blend = true;
      this.setAllStencilOps(this._vcColorRenderState!, GL.StencilOperation.Zero);
      System.instance.context.clearStencil(0); // must clear stencil afterwards since we had to draw with stencil set to KEEP
      System.instance.context.clear(GL.BufferBit.Stencil);
      this.target.popBranch();
      System.instance.bindTexture2d(TextureUnit.PlanarClassification, undefined);
      return;
    }

    if ((needOutsideDraw && cmds.length > 0) || (needInsideDraw && !(doColorByElement && doColorByElementForIntersectingVolumes))) {
      // Set the stencil using all of the volume classifiers.  This will be used to do the outside and/or the inside if they need to be done.
      // If we are not modifying the outside and the inside is using color-by-element for intersecting volumes, then the stencil will get set later.
      fbStack.execute(zOnlyFbo, false, this.useMsBuffers, () => {
        this.target.pushState(this._vcBranchState!);
        System.instance.applyRenderState(this._vcSetStencilRenderState!);
        this.target.techniques.execute(this.target, cmds, RenderPass.Classification);
        this.target.popBranch();
        System.instance.bindTexture2d(TextureUnit.Two, undefined);
        System.instance.bindTexture2d(TextureUnit.Five, undefined);
      });
    }
    if (needOutsideDraw) {
      if (this._antialiasSamples > 1 && undefined !== this._depthMS && this.useMsBuffers)
        volClassBlendReadZTextureFbo.blitMsBuffersToTextures(true, -1); // make sure that the Z buffer that we are about to read has been blitted
      fbStack.execute(volClassBlendFbo, false, this.useMsBuffers, () => {
        this._geom.volClassSetBlend!.boundaryType = BoundaryType.Outside;
        this._geom.volClassSetBlend!.texture = volClassBlendReadZTexture;
        this.target.pushState(this.target.decorationsState);
        this._vcColorRenderState!.flags.blend = false;
        this._vcColorRenderState!.stencil.frontFunction.function = GL.StencilFunction.Equal; // temp swap the functions so we get what is not set in the stencil
        this._vcColorRenderState!.stencil.backFunction.function = GL.StencilFunction.Equal;
        if (needInsideDraw)
          this.setAllStencilOps(this._vcColorRenderState!, GL.StencilOperation.Keep); // don't clear the stencil since we'll use it again
        System.instance.applyRenderState(this._vcColorRenderState!);
        const params = getDrawParams(this.target, this._geom.volClassSetBlend!);
        this.target.techniques.draw(params);
        this._vcColorRenderState!.flags.blend = true;
        this._vcColorRenderState!.stencil.frontFunction.function = GL.StencilFunction.NotEqual;
        this._vcColorRenderState!.stencil.backFunction.function = GL.StencilFunction.NotEqual;
        if (needInsideDraw)
          this.setAllStencilOps(this._vcColorRenderState!, GL.StencilOperation.Zero);
        this.target.popBranch();
        System.instance.bindTexture2d(TextureUnit.Zero, undefined); // unbind the depth buffer that we used as a texture as we'll need it as an output later
      });
    }
    if (needInsideDraw) {
      if (!doColorByElement) {
        // In this case our stencil is already set and it is all getting colored the same, so we can just draw with a viewport quad to color it.
        if (this._antialiasSamples > 1 && undefined !== this._depthMS && this.useMsBuffers)
          volClassBlendReadZTextureFbo.blitMsBuffersToTextures(true, -1); // make sure that the Z buffer that we are about to read has been blitted
        fbStack.execute(volClassBlendFbo, false, this.useMsBuffers, () => {
          this._geom.volClassSetBlend!.boundaryType = BoundaryType.Inside;
          this._geom.volClassSetBlend!.texture = volClassBlendReadZTexture;
          this.target.pushState(this.target.decorationsState);
          this._vcColorRenderState!.flags.blend = false;
          System.instance.applyRenderState(this._vcColorRenderState!);
          const params = getDrawParams(this.target, this._geom.volClassSetBlend!);
          this.target.techniques.draw(params);
          this._vcColorRenderState!.flags.blend = true;
          this.target.popBranch();
          System.instance.bindTexture2d(TextureUnit.Zero, undefined);
        });
      } else if (doColorByElementForIntersectingVolumes) {
        // If we have intersecting classifier volumes, then we must stencil them individually to get their colors in the blend texture.
        for (let i = 0; i < cmdsByIndex.length; i += numCmdsPerClassifier) {
          const nxtCmds = cmdsByIndex.slice(i, i + numCmdsPerClassifier);
          // Set the stencil for this one classifier.
          fbStack.execute(zOnlyFbo, false, this.useMsBuffers, () => {
            this.target.pushState(this._vcBranchState!);
            System.instance.applyRenderState(this._vcSetStencilRenderState!);
            this.target.techniques.execute(this.target, nxtCmds, RenderPass.Classification);
            this.target.popBranch();
          });
          // Process the stencil. Just render the volume normally (us opaque pass), but use blending to modify the source alpha that gets written to the blend texture.
          fbStack.execute(volClassBlendFbo, true, this.useMsBuffers, () => {
            this.target.pushState(this._vcBranchState!);
            this._vcColorRenderState!.blend.color = [1.0, 1.0, 1.0, 0.35];
            this._vcColorRenderState!.blend.setBlendFuncSeparate(GL.BlendFactor.One, GL.BlendFactor.ConstAlpha, GL.BlendFactor.Zero, GL.BlendFactor.Zero);
            this._vcColorRenderState!.flags.cull = true;
            System.instance.applyRenderState(this._vcColorRenderState!);
            this.target.activeVolumeClassifierTexture = undefined; // make sure this texture is undefined so we do not use the planar classification shader
            this.target.techniques.execute(this.target, nxtCmds, RenderPass.OpaqueGeneral);
            this._vcColorRenderState!.flags.cull = false;
            this.target.popBranch();
          });
        }
      } else {
        if (this._antialiasSamples > 1 && undefined !== this._depthMS && this.useMsBuffers)
          this._fbos.stencilSet.blitMsBuffersToTextures(true, -1); // make sure that the Z buffer that we are about to read has been blitted
        fbStack.execute(volClassBlendFbo, false, this.useMsBuffers, () => {
          // For coloring the inside by element color we will draw the inside using the the classifiers themselves.
          // To do this we need to first clear our Alt-Z.  The shader will then test and write Z and will discard
          // anything that is in front of the reality model by reading the Z texture from the standard Z buffer (which has the reality mesh Z's in it).
          // What we end up with is the closest volume behind the terrain which works if the classifier volumes do not intersect.
          // Since we need the blend texture to have alpha in it, we will use blending just to modify the alpha that gets written.
          this.target.pushState(this._vcBranchState!);
          this._vcColorRenderState!.blend.color = [1.0, 1.0, 1.0, 0.35];
          this._vcColorRenderState!.blend.setBlendFuncSeparate(GL.BlendFactor.One, GL.BlendFactor.ConstAlpha, GL.BlendFactor.Zero, GL.BlendFactor.Zero);
          this._vcColorRenderState!.flags.depthTest = true;
          this._vcColorRenderState!.flags.depthMask = true;
          this._vcColorRenderState!.flags.cull = true;
          this.setAllStencilOps(this._vcColorRenderState!, GL.StencilOperation.Keep); // don't clear the stencil so that all classifiers behind reality mesh will still draw
          System.instance.applyRenderState(this._vcColorRenderState!);
          System.instance.context.clearDepth(1.0);
          System.instance.context.clear(GL.BufferBit.Depth);
          this.target.activeVolumeClassifierTexture = this._geom.volClassCopyZ!.texture;
          this.target.techniques.execute(this.target, cmds, RenderPass.OpaqueGeneral);
          this.target.activeVolumeClassifierTexture = undefined;
          this._vcColorRenderState!.flags.depthTest = false;
          this._vcColorRenderState!.flags.depthMask = false;
          this._vcColorRenderState!.flags.cull = false;
          this.setAllStencilOps(this._vcColorRenderState!, GL.StencilOperation.Zero);
          System.instance.context.clearStencil(0); // must clear stencil afterwards since we had to draw with stencil set to KEEP
          System.instance.context.clear(GL.BufferBit.Stencil);
          this.target.popBranch();
          System.instance.bindTexture2d(TextureUnit.PlanarClassification, undefined);
        });
      }
    }

    // Handle the selected classifier volumes.  Note though that if color-by-element is being used, then the selected volumes are already hilited
    // and this stage can be skipped.  In order for this to work the list of commands needs to get reduced to only the ones which draw hilited volumes.
    // We cannot use the hillite shader to draw them since it doesn't handle logZ properly (it doesn't need to since it is only used elsewhere when Z write is turned off)
    // and we don't really want another whole set of hilite shaders just for this.
    const cmdsSelected = extractHilitedVolumeClassifierCommands(this.target.hilites, commands.getCommands(RenderPass.HiliteClassification));
    commands.replaceCommands(RenderPass.HiliteClassification, cmdsSelected); // replace the hilite command list for use in hilite pass as well.
    // if (cmdsSelected.length > 0 && insideFlags !== this.target.activeVolumeClassifierProps!.flags.selected) {
    if (!doColorByElement && cmdsSelected.length > 0 && insideFlags !== SpatialClassifierInsideDisplay.Hilite) { // assume selected ones are always hilited
      // Set the stencil using just the hilited volume classifiers.
      fbStack.execute(this._fbos.stencilSet, false, this.useMsBuffers, () => {
        this.target.pushState(this._vcBranchState!);
        System.instance.applyRenderState(this._vcSetStencilRenderState!);
        if (needAltZ) {
          // If we are using the alternate Z then the stencil that goes with the original Z has not been cleared yet, so clear it here.
          System.instance.context.clearStencil(0);
          System.instance.context.clear(GL.BufferBit.Stencil);
        }

        this.target.techniques.execute(this.target, cmdsSelected, RenderPass.Classification);
        this.target.popBranch();
      });
      if (this._antialiasSamples > 1 && undefined !== this._depthMS && this.useMsBuffers)
        this._fbos.altZOnly.blitMsBuffersToTextures(true, -1); // make sure that the Z buffer that we are about to read has been blitted

      fbStack.execute(this._fbos.volClassCreateBlend!, false, this.useMsBuffers, () => {
        this._geom.volClassSetBlend!.boundaryType = BoundaryType.Selected;
        this._geom.volClassSetBlend!.texture = this._vcAltDepthStencil!.getHandle()!; // need to attach the alt depth instead of the real one since it is bound to the frame buffer
        this.target.pushState(this.target.decorationsState);
        this._vcColorRenderState!.flags.blend = false;
        System.instance.applyRenderState(this._vcColorRenderState!);
        const params = getDrawParams(this.target, this._geom.volClassSetBlend!);
        this.target.techniques.draw(params);
        this._vcColorRenderState!.flags.blend = true;
        this.target.popBranch();
        System.instance.bindTexture2d(TextureUnit.Zero, undefined);
      });
    }

    // Now modify the color of the reality mesh by using the blend texture to blend with it.
    if (this._antialiasSamples > 1 && undefined !== this._depthMS && this.useMsBuffers) {
      volClassBlendFbo.blitMsBuffersToTextures(false); // make sure the volClassBlend texture that we are about to read has been blitted
    }

    fbStack.execute(fboColorAndZ, false, this.useMsBuffers, () => {
      this.target.pushState(this.target.decorationsState);
      this._vcBlendRenderState!.blend.setBlendFuncSeparate(GL.BlendFactor.SrcAlpha, GL.BlendFactor.Zero, GL.BlendFactor.OneMinusSrcAlpha, GL.BlendFactor.One);
      System.instance.applyRenderState(this._vcBlendRenderState!);
      const params = getDrawParams(this.target, this._geom.volClassBlend!);
      this.target.techniques.draw(params);
      this.target.popBranch();
      System.instance.bindTexture2d(TextureUnit.Zero, undefined);
    });

    // Process the flashed classifier if there is one.
    // Like the selected volumes, we do not need to do this step if we used by-element-color since the flashing is included in the element color.
    const flashedClassifierCmds = extractFlashedVolumeClassifierCommands(this.target.flashedId, cmdsByIndex, numCmdsPerClassifier);
    if (undefined !== flashedClassifierCmds && !doColorByElement) {
      // Set the stencil for this one classifier.
      fbStack.execute(this._fbos.stencilSet, false, this.useMsBuffers, () => {
        this.target.pushState(this._vcBranchState!);
        System.instance.applyRenderState(this._vcSetStencilRenderState!);
        this.target.techniques.executeForIndexedClassifier(this.target, flashedClassifierCmds, RenderPass.OpaqueGeneral);
        this.target.popBranch();
      });

      // Process the stencil to flash the contents.
      fbStack.execute(fboColorAndZ, true, this.useMsBuffers, () => {
        this.target.pushState(this.target.decorationsState);
        this._vcColorRenderState!.blend.color = [1.0, 1.0, 1.0, this.target.flashIntensity * 0.2];
        this._vcColorRenderState!.blend.setBlendFuncSeparate(GL.BlendFactor.ConstAlpha, GL.BlendFactor.Zero, GL.BlendFactor.One, GL.BlendFactor.One);
        System.instance.applyRenderState(this._vcColorRenderState!);
        const params = getDrawParams(this.target, this._geom.volClassColorStencil!);
        this.target.techniques.draw(params);
        this.target.popBranch();
      });
    }
  }

  private renderHilite(commands: RenderCommands) {
    const system = System.instance;
    system.frameBufferStack.execute(this._fbos.hilite!, true, false, () => {
      // Clear the hilite buffer.
      system.context.clearColor(0, 0, 0, 0);
      system.context.clear(GL.BufferBit.Color);
      // Draw the normal hilite geometry.
      this.drawPass(commands, RenderPass.Hilite);
    });

    // Process planar classifiers
    const planarClassifierCmds = commands.getCommands(RenderPass.HilitePlanarClassification);
    if (0 !== planarClassifierCmds.length) {
      system.frameBufferStack.execute(this._fbos.hiliteUsingStencil!, true, false, () => {
        system.applyRenderState(this._opaqueRenderState);
        this.target.techniques.execute(this.target, planarClassifierCmds, RenderPass.HilitePlanarClassification);
      });
    }

    // Process the volume classifiers.
    const vcHiliteCmds = commands.getCommands(RenderPass.HiliteClassification);
    if (0 !== vcHiliteCmds.length && undefined !== this._vcBranchState) {
      // Set the stencil for the given classifier stencil volume.
      system.frameBufferStack.execute(this._fbos.stencilSet!, false, false, () => {
        this.target.pushState(this._vcBranchState!);
        system.applyRenderState(this._vcSetStencilRenderState!);
        this.target.techniques.execute(this.target, vcHiliteCmds, RenderPass.Hilite);
        this.target.popBranch();
      });
      // Process the stencil for the hilite data.
      system.frameBufferStack.execute(this._fbos.hiliteUsingStencil!, true, false, () => {
        system.applyRenderState(this._vcPickDataRenderState!);
        this.target.techniques.execute(this.target, vcHiliteCmds, RenderPass.Hilite);
      });
    }
  }

  private composite() {
    System.instance.applyRenderState(RenderState.defaults);
    const params = getDrawParams(this.target, this._geom.composite!);
    this.target.techniques.draw(params);
  }

  protected getRenderState(pass: RenderPass): RenderState {
    switch (pass) {
      case RenderPass.OpaqueLayers:
      case RenderPass.TranslucentLayers:
      case RenderPass.OverlayLayers:
        // NB: During pick, we don't want blending - it will mess up our pick buffer data and we don't care about the color data.
        // During normal draw, we don't use the pick buffers for anything, and we want color blending.
        // (We get away with this because surfaces always draw before their edges, and we're not depth-testing, so edges always draw atop surfaces without pick buffer testing).
        this._layerRenderState.flags.blend = !this.target.isReadPixelsInProgress;

        // Transparent non-overlay Layers are drawn between opaque and translucent passes. Test depth, don't write it, so that they blend with opaque.
        this._layerRenderState.flags.depthMask = RenderPass.TranslucentLayers !== pass;
        this._layerRenderState.depthFunc = (RenderPass.TranslucentLayers === pass) ? GL.DepthFunc.Default : GL.DepthFunc.Always;
        return this._layerRenderState;
      case RenderPass.OpaqueLinear:
      case RenderPass.OpaquePlanar:
      case RenderPass.OpaqueGeneral:
      case RenderPass.HilitePlanarClassification:
        return this._opaqueRenderState;
      case RenderPass.Translucent:
        return this._translucentRenderState;
      case RenderPass.Hilite:
        return this._hiliteRenderState;
      case RenderPass.BackgroundMap:
        return this._backgroundMapRenderState;
      case RenderPass.PointClouds:
        return this._pointCloudRenderState;
      default:
        return this._noDepthMaskRenderState;
    }
  }

  protected drawPass(commands: RenderCommands, pass: RenderPass, pingPong: boolean = false, cmdPass: RenderPass = RenderPass.None) {
    const cmds = commands.getCommands(RenderPass.None !== cmdPass ? cmdPass : pass);
    if (0 === cmds.length) {
      return;
    } else if (pingPong) {
      this.pingPong();
    }

    System.instance.applyRenderState(this.getRenderState(pass));
    this.target.techniques.execute(this.target, cmds, pass);
  }
}

interface SinglePointCloudData {
  pcs?: PointCloudDisplaySettings;
  cmds: DrawCommands;
}
