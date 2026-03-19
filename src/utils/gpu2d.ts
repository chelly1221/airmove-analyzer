/**
 * 경량 WebGL2 2D 렌더러 — 각 캔버스에 직접 WebGL2 컨텍스트 생성
 * powerPreference: 'high-performance' → 이산 GPU(RTX 등) 우선 선택
 */

// ── 셰이더 소스 ──

const CIRCLE_VERT = `#version 300 es
layout(location=0) in vec2 a_quad;
layout(location=1) in vec2 a_center;
layout(location=2) in float a_radius;
layout(location=3) in vec4 a_fill;
layout(location=4) in vec4 a_stroke;
layout(location=5) in float a_strokeW;
uniform vec2 u_res;
out vec2 v_local;
out vec4 v_fill;
out vec4 v_stroke;
out float v_r;
out float v_sw;
void main(){
  float ext = a_radius + a_strokeW + 1.0;
  v_local = a_quad * ext;
  vec2 pos = a_center + v_local;
  vec2 ndc = (pos / u_res) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_fill = a_fill; v_stroke = a_stroke; v_r = a_radius; v_sw = a_strokeW;
}`;

const CIRCLE_FRAG = `#version 300 es
precision highp float;
in vec2 v_local;
in vec4 v_fill;
in vec4 v_stroke;
in float v_r;
in float v_sw;
out vec4 fragColor;
void main(){
  float d = length(v_local);
  float outer = v_r + v_sw;
  float aa = 1.0 - smoothstep(outer - 0.7, outer + 0.7, d);
  if(aa < 0.005) discard;
  float inner = 1.0 - smoothstep(v_r - 0.5, v_r + 0.5, d);
  vec4 c = mix(v_stroke, v_fill, inner);
  fragColor = vec4(c.rgb, c.a * aa);
}`;

const RECT_VERT = `#version 300 es
layout(location=0) in vec2 a_quad;
layout(location=1) in vec4 a_rect;
layout(location=2) in vec4 a_color;
uniform vec2 u_res;
out vec4 v_color;
void main(){
  vec2 pos = a_rect.xy + a_quad * a_rect.zw;
  vec2 ndc = (pos / u_res) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_color = a_color;
}`;

const RECT_FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main(){ fragColor = v_color; }`;

const LINE_VERT = `#version 300 es
layout(location=0) in vec2 a_quad;
layout(location=1) in vec2 a_start;
layout(location=2) in vec2 a_end;
layout(location=3) in float a_width;
layout(location=4) in vec4 a_color;
uniform vec2 u_res;
out vec4 v_color;
void main() {
  vec2 dir = a_end - a_start;
  float len = length(dir);
  if (len < 0.001) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  vec2 fwd = dir / len;
  vec2 right = vec2(fwd.y, -fwd.x);
  vec2 pos = a_start + fwd * (a_quad.x + 0.5) * len + right * a_quad.y * a_width;
  vec2 ndc = (pos / u_res) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_color = a_color;
}`;

const LINE_FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() { fragColor = v_color; }`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`Shader compile error: ${log}`);
  }
  return s;
}

function linkProg(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`Program link error: ${log}`);
  }
  return p;
}

export interface CircleData {
  x: number; y: number; r: number;
  fill: [number, number, number, number];
  stroke: [number, number, number, number];
  strokeWidth: number;
}

export interface RectData {
  x: number; y: number; w: number; h: number;
  color: [number, number, number, number];
}

export interface LineData {
  x1: number; y1: number;
  x2: number; y2: number;
  width: number;
  color: [number, number, number, number];
}

export class GPU2D {
  private gl: WebGL2RenderingContext;
  private cProg: WebGLProgram;
  private rProg: WebGLProgram;
  private lProg: WebGLProgram;
  private cVAO: WebGLVertexArrayObject;
  private rVAO: WebGLVertexArrayObject;
  private lVAO: WebGLVertexArrayObject;
  private cInstBuf: WebGLBuffer;
  private rInstBuf: WebGLBuffer;
  private lInstBuf: WebGLBuffer;
  private cResLoc: WebGLUniformLocation;
  private rResLoc: WebGLUniformLocation;
  private lResLoc: WebGLUniformLocation;
  private cQuadBuf: WebGLBuffer;
  private rQuadBuf: WebGLBuffer;
  private lQuadBuf: WebGLBuffer;
  private vw = 0;
  private vh = 0;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Circle program
    const cvs = compile(gl, gl.VERTEX_SHADER, CIRCLE_VERT);
    const cfs = compile(gl, gl.FRAGMENT_SHADER, CIRCLE_FRAG);
    this.cProg = linkProg(gl, cvs, cfs);
    this.cResLoc = gl.getUniformLocation(this.cProg, 'u_res')!;
    gl.deleteShader(cvs); gl.deleteShader(cfs);

    // Rect program
    const rvs = compile(gl, gl.VERTEX_SHADER, RECT_VERT);
    const rfs = compile(gl, gl.FRAGMENT_SHADER, RECT_FRAG);
    this.rProg = linkProg(gl, rvs, rfs);
    this.rResLoc = gl.getUniformLocation(this.rProg, 'u_res')!;
    gl.deleteShader(rvs); gl.deleteShader(rfs);

    // Line program
    const lvs = compile(gl, gl.VERTEX_SHADER, LINE_VERT);
    const lfs = compile(gl, gl.FRAGMENT_SHADER, LINE_FRAG);
    this.lProg = linkProg(gl, lvs, lfs);
    this.lResLoc = gl.getUniformLocation(this.lProg, 'u_res')!;
    gl.deleteShader(lvs); gl.deleteShader(lfs);

    // Circle quad
    this.cQuadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

    // Rect quad
    this.rQuadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 1,1]), gl.STATIC_DRAW);

    // Line quad
    this.lQuadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5,-0.5, 0.5,-0.5, -0.5,0.5, 0.5,0.5]), gl.STATIC_DRAW);

    // Instance buffers
    this.cInstBuf = gl.createBuffer()!;
    this.rInstBuf = gl.createBuffer()!;
    this.lInstBuf = gl.createBuffer()!;

    // Circle VAO
    this.cVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.cVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cQuadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cInstBuf);
    const CS = 48;
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, CS, 0);  gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, CS, 8);  gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, CS, 12); gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.FLOAT, false, CS, 28); gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.FLOAT, false, CS, 44); gl.vertexAttribDivisor(5, 1);
    gl.bindVertexArray(null);

    // Rect VAO
    this.rVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.rVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rQuadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rInstBuf);
    const RS = 32;
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, RS, 0);  gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, RS, 16); gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);

    // Line VAO
    this.lVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.lVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lQuadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lInstBuf);
    const LS = 36;
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, LS, 0);  gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, LS, 8);  gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, LS, 16); gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.FLOAT, false, LS, 20); gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);
  }

  /** 가상 해상도 설정 (SVG viewBox 또는 CSS 픽셀 크기) */
  setResolution(w: number, h: number) { this.vw = w; this.vh = h; }

  /** 캔버스 실제 픽셀 크기를 CSS 크기에 동기화 (DPR 반영) */
  syncSize(cssW: number, cssH: number) {
    const dpr = window.devicePixelRatio || 1;
    const c = this.gl.canvas as HTMLCanvasElement;
    const pw = Math.round(cssW * dpr);
    const ph = Math.round(cssH * dpr);
    if (c.width !== pw || c.height !== ph) {
      c.width = pw; c.height = ph;
      this.gl.viewport(0, 0, pw, ph);
    }
  }

  clear() {
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  /** 시저 클리핑 (가상 좌표 기준) */
  scissor(x: number, y: number, w: number, h: number) {
    const gl = this.gl;
    const c = gl.canvas as HTMLCanvasElement;
    gl.enable(gl.SCISSOR_TEST);
    const sx = (x / this.vw) * c.width;
    const sh = (h / this.vh) * c.height;
    const sy = c.height - (y / this.vh) * c.height - sh;
    gl.scissor(Math.round(sx), Math.round(sy), Math.round((w / this.vw) * c.width), Math.round(sh));
  }

  noScissor() { this.gl.disable(this.gl.SCISSOR_TEST); }

  /** no-op (직접 렌더링이므로 flush 불필요, API 호환용) */
  flush() {}

  drawCircles(circles: CircleData[]) {
    if (!circles.length) return;
    const gl = this.gl;
    const buf = new Float32Array(circles.length * 12);
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i], o = i * 12;
      buf[o]=c.x; buf[o+1]=c.y; buf[o+2]=c.r;
      buf[o+3]=c.fill[0]; buf[o+4]=c.fill[1]; buf[o+5]=c.fill[2]; buf[o+6]=c.fill[3];
      buf[o+7]=c.stroke[0]; buf[o+8]=c.stroke[1]; buf[o+9]=c.stroke[2]; buf[o+10]=c.stroke[3];
      buf[o+11]=c.strokeWidth;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cInstBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
    gl.useProgram(this.cProg);
    gl.uniform2f(this.cResLoc, this.vw, this.vh);
    gl.bindVertexArray(this.cVAO);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, circles.length);
    gl.bindVertexArray(null);
  }

  drawRects(rects: RectData[]) {
    if (!rects.length) return;
    const gl = this.gl;
    const buf = new Float32Array(rects.length * 8);
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i], o = i * 8;
      buf[o]=r.x; buf[o+1]=r.y; buf[o+2]=r.w; buf[o+3]=r.h;
      buf[o+4]=r.color[0]; buf[o+5]=r.color[1]; buf[o+6]=r.color[2]; buf[o+7]=r.color[3];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rInstBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
    gl.useProgram(this.rProg);
    gl.uniform2f(this.rResLoc, this.vw, this.vh);
    gl.bindVertexArray(this.rVAO);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, rects.length);
    gl.bindVertexArray(null);
  }

  drawLines(lines: LineData[]) {
    if (!lines.length) return;
    const gl = this.gl;
    const buf = new Float32Array(lines.length * 9);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i], o = i * 9;
      buf[o]=l.x1; buf[o+1]=l.y1; buf[o+2]=l.x2; buf[o+3]=l.y2;
      buf[o+4]=l.width;
      buf[o+5]=l.color[0]; buf[o+6]=l.color[1]; buf[o+7]=l.color[2]; buf[o+8]=l.color[3];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lInstBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
    gl.useProgram(this.lProg);
    gl.uniform2f(this.lResLoc, this.vw, this.vh);
    gl.bindVertexArray(this.lVAO);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, lines.length);
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteProgram(this.cProg);
    gl.deleteProgram(this.rProg);
    gl.deleteProgram(this.lProg);
    gl.deleteVertexArray(this.cVAO);
    gl.deleteVertexArray(this.rVAO);
    gl.deleteVertexArray(this.lVAO);
    gl.deleteBuffer(this.cInstBuf);
    gl.deleteBuffer(this.rInstBuf);
    gl.deleteBuffer(this.lInstBuf);
    gl.deleteBuffer(this.cQuadBuf);
    gl.deleteBuffer(this.rQuadBuf);
    gl.deleteBuffer(this.lQuadBuf);
  }
}
