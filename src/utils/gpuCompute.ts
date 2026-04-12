/**
 * WebGPU Compute infrastructure — prefer discrete GPU
 * Used for Coverage Phase 2, Loss Detection, and other large parallel computations
 * GPU 필수 — 미지원 시 에러 throw
 */

let _device: GPUDevice | null = null;
let _initPromise: Promise<GPUDevice> | null = null;
let _available: boolean | null = null;
let _lastError: string | null = null;

/** 파이프라인 캐시 — 동일 셰이더+바인딩 레이아웃은 1회만 컴파일 */
const _pipelineCache = new Map<string, { pipeline: GPUComputePipeline; layout: GPUBindGroupLayout }>();

/** GPU 에러 메시지 (초기화 실패 시) */
export function getGPUError(): string | null {
  return _lastError;
}

/** WebGPU device initialization (singleton, prefer discrete GPU) — 실패 시 throw */
export async function getGPUDevice(): Promise<GPUDevice> {
  // 이전에 실패했으면 동일 에러 재발생 (재시도 없음)
  if (_lastError) throw new Error(_lastError);
  if (_device) return _device;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    if (!navigator.gpu) {
      _available = false;
      _lastError = "이 브라우저에서 WebGPU를 지원하지 않습니다. Chromium 기반 브라우저가 필요합니다.";
      throw new Error(_lastError);
    }

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance", // discrete GPU preferred
    });
    if (!adapter) {
      _available = false;
      _lastError = "GPU 어댑터를 찾을 수 없습니다. 외장/내장 GPU가 설치되어 있는지 확인하세요.";
      throw new Error(_lastError);
    }

    // Log adapter info
    const info = adapter.info;
    console.log(`[GPU] Adapter: ${info.vendor} ${info.device} (${info.description})`);

    try {
      _device = await adapter.requestDevice({
        requiredLimits: {
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          maxBufferSize: adapter.limits.maxBufferSize,
          maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
        },
      });
    } catch (err) {
      _available = false;
      _lastError = `GPU 디바이스 생성 실패: ${err instanceof Error ? err.message : String(err)}`;
      throw new Error(_lastError);
    }

    _device.lost.then((lostInfo) => {
      console.warn(`[GPU] Device lost: ${lostInfo.message}`);
      _pipelineCache.clear();
      // _lastError를 설정하지 않음 — 다음 getGPUDevice() 호출 시 재초기화 시도 허용
      _device = null;
      _initPromise = null;
      _available = null;
    });

    _available = true;
    _lastError = null;
    console.log("[GPU] WebGPU device initialized (high-performance)");
    return _device;
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
 * 셰이더 코드 + 바인딩 타입 조합으로 파이프라인 캐시 조회/생성.
 * 동일 셰이더를 반복 호출하는 커버리지 계산에서 ~80회 컴파일을 2회로 감소.
 */
function getOrCreatePipeline(
  device: GPUDevice,
  shaderCode: string,
  bindingTypes: ("read-only-storage" | "storage" | "uniform")[],
): { pipeline: GPUComputePipeline; layout: GPUBindGroupLayout } {
  // 셰이더 길이 + 처음 64자 + 바인딩 타입으로 충돌 방지
  const key = shaderCode.length + ":" + shaderCode.slice(0, 64) + "|" + bindingTypes.join(",");
  const cached = _pipelineCache.get(key);
  if (cached) return cached;

  const module = device.createShaderModule({ code: shaderCode });
  const entries: GPUBindGroupLayoutEntry[] = bindingTypes.map((type, i) => ({
    binding: i,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type },
  }));
  const layout = device.createBindGroupLayout({ entries });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipeline = device.createComputePipeline({
    layout: pipelineLayout,
    compute: { module, entryPoint: "main" },
  });

  const result = { pipeline, layout };
  _pipelineCache.set(key, result);
  console.log(`[GPU] Pipeline cached (bindings: ${bindingTypes.join(",")})`);
  return result;
}

/**
 * Generic compute shader execution helper (파이프라인 자동 캐시)
 */
export async function runComputeShader(
  device: GPUDevice,
  shaderCode: string,
  bindings: { buffer: GPUBuffer; type: "read-only-storage" | "storage" | "uniform" }[],
  workgroupCount: [number, number, number],
): Promise<void> {
  const { pipeline, layout } = getOrCreatePipeline(
    device, shaderCode, bindings.map(b => b.type),
  );

  const bindGroup = device.createBindGroup({
    layout,
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
