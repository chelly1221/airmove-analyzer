/**
 * WebGPU Compute infrastructure — prefer discrete GPU
 * Used for Coverage Phase 2, Loss Detection, and other large parallel computations
 * Falls back to CPU when WebGPU is not available
 */

let _device: GPUDevice | null = null;
let _initPromise: Promise<GPUDevice | null> | null = null;
let _available: boolean | null = null;

/** WebGPU device initialization (singleton, prefer discrete GPU) */
export async function getGPUDevice(): Promise<GPUDevice | null> {
  if (_device) return _device;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      if (!navigator.gpu) {
        console.warn("[GPU] WebGPU not available in this browser");
        _available = false;
        return null;
      }

      const adapter = await navigator.gpu.requestAdapter({
        powerPreference: "high-performance", // discrete GPU preferred
      });
      if (!adapter) {
        console.warn("[GPU] No GPU adapter found");
        _available = false;
        return null;
      }

      // Log adapter info
      const info = adapter.info;
      console.log(`[GPU] Adapter: ${info.vendor} ${info.device} (${info.description})`);

      _device = await adapter.requestDevice({
        requiredLimits: {
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          maxBufferSize: adapter.limits.maxBufferSize,
          maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
        },
      });

      _device.lost.then((lostInfo) => {
        console.warn(`[GPU] Device lost: ${lostInfo.message}`);
        _device = null;
        _initPromise = null;
        _available = null;
      });

      _available = true;
      console.log("[GPU] WebGPU device initialized (high-performance)");
      return _device;
    } catch (err) {
      console.warn("[GPU] WebGPU init failed:", err);
      _available = false;
      return null;
    }
  })();

  return _initPromise;
}

/** WebGPU availability (after initialization) */
export function isGPUAvailable(): boolean | null {
  return _available;
}

/** GPU buffer creation helper */
export function createBuffer(
  device: GPUDevice,
  data: Float32Array | Uint32Array,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage,
    mappedAtCreation: true,
  });
  if (data instanceof Float32Array) {
    new Float32Array(buffer.getMappedRange()).set(data);
  } else {
    new Uint32Array(buffer.getMappedRange()).set(data);
  }
  buffer.unmap();
  return buffer;
}

/** GPU result read helper */
export async function readBuffer(
  device: GPUDevice,
  buffer: GPUBuffer,
  size: number,
): Promise<Float32Array> {
  const readBuf = device.createBuffer({
    size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, readBuf, 0, size);
  device.queue.submit([encoder.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();
  readBuf.destroy();
  return result;
}

/**
 * Generic compute shader execution helper
 */
export async function runComputeShader(
  device: GPUDevice,
  shaderCode: string,
  bindings: { buffer: GPUBuffer; type: "read-only-storage" | "storage" | "uniform" }[],
  workgroupCount: [number, number, number],
): Promise<void> {
  const module = device.createShaderModule({ code: shaderCode });

  const entries: GPUBindGroupLayoutEntry[] = bindings.map((b, i) => ({
    binding: i,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: b.type },
  }));

  const bindGroupLayout = device.createBindGroupLayout({ entries });
  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  const pipeline = device.createComputePipeline({
    layout: pipelineLayout,
    compute: { module, entryPoint: "main" },
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: bindings.map((b, i) => ({
      binding: i,
      resource: { buffer: b.buffer },
    })),
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(...workgroupCount);
  pass.end();
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
}
