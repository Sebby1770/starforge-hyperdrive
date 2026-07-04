export type RenderBackend = "webgl" | "canvas2d";

export type RenderMetrics = {
  backend: RenderBackend;
  uploadMs: number;
  drawMs: number;
};

type Renderer = {
  backend: RenderBackend;
  resize(width: number, height: number): void;
  draw(framebuffer: Uint8ClampedArray, width: number, height: number): RenderMetrics;
  destroy(): void;
};

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const webgl = tryCreateWebGlRenderer(canvas);
  if (webgl) {
    return webgl;
  }

  const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!context) {
    throw new Error("Neither WebGL nor 2D canvas is available.");
  }

  let imageData = new ImageData(1, 1);
  return {
    backend: "canvas2d",
    resize(width: number, height: number) {
      canvas.width = width;
      canvas.height = height;
      context.imageSmoothingEnabled = true;
      imageData = new ImageData(width, height);
    },
    draw(framebuffer: Uint8ClampedArray, width: number, height: number) {
      const uploadStart = performance.now();
      imageData.data.set(framebuffer);
      const uploadMs = performance.now() - uploadStart;

      const drawStart = performance.now();
      context.putImageData(imageData, 0, 0);
      const drawMs = performance.now() - drawStart;

      return { backend: "canvas2d", uploadMs, drawMs };
    },
    destroy() {}
  };
}

function tryCreateWebGlRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const gl =
    canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance"
    }) ??
    canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance"
    });

  if (!gl) {
    return null;
  }

  const isWebGl2 = gl instanceof WebGL2RenderingContext;
  const vertexSource = isWebGl2
    ? `#version 300 es
       in vec2 position;
       out vec2 vUv;
       void main() {
         vUv = position * 0.5 + 0.5;
         gl_Position = vec4(position, 0.0, 1.0);
       }`
    : `attribute vec2 position;
       varying vec2 vUv;
       void main() {
         vUv = position * 0.5 + 0.5;
         gl_Position = vec4(position, 0.0, 1.0);
       }`;

  const fragmentSource = isWebGl2
    ? `#version 300 es
       precision mediump float;
       uniform sampler2D uTexture;
       in vec2 vUv;
       out vec4 outColor;
       void main() {
         vec4 color = texture(uTexture, vUv);
         float energy = dot(color.rgb, vec3(0.299, 0.587, 0.114));
         color.rgb = mix(color.rgb, color.rgb * (0.92 + energy * 0.18), 0.35);
         outColor = color;
       }`
    : `precision mediump float;
       uniform sampler2D uTexture;
       varying vec2 vUv;
       void main() {
         vec4 color = texture2D(uTexture, vUv);
         float energy = dot(color.rgb, vec3(0.299, 0.587, 0.114));
         color.rgb = mix(color.rgb, color.rgb * (0.92 + energy * 0.18), 0.35);
         gl_FragColor = color;
       }`;

  const program = createProgram(gl, vertexSource, fragmentSource);
  if (!program) {
    return null;
  }

  const positionLocation = gl.getAttribLocation(program, "position");
  const textureLocation = gl.getUniformLocation(program, "uTexture");
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  const vao = isWebGl2 ? (gl as WebGL2RenderingContext).createVertexArray() : null;

  if (!buffer || !texture) {
    return null;
  }

  const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

  if (isWebGl2 && vao) {
    const gl2 = gl as WebGL2RenderingContext;
    gl2.bindVertexArray(vao);
    gl2.bindBuffer(gl2.ARRAY_BUFFER, buffer);
    gl2.bufferData(gl2.ARRAY_BUFFER, vertices, gl2.STATIC_DRAW);
    gl2.enableVertexAttribArray(positionLocation);
    gl2.vertexAttribPointer(positionLocation, 2, gl2.FLOAT, false, 0, 0);
    gl2.bindVertexArray(null);
  } else {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  let textureWidth = 0;
  let textureHeight = 0;

  return {
    backend: "webgl",
    resize(width: number, height: number) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      textureWidth = width;
      textureHeight = height;

      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null
      );
    },
    draw(framebuffer: Uint8ClampedArray, width: number, height: number) {
      const uploadStart = performance.now();

      gl.bindTexture(gl.TEXTURE_2D, texture);
      if (textureWidth !== width || textureHeight !== height) {
        textureWidth = width;
        textureHeight = height;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, framebuffer);
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, framebuffer);
      }

      const uploadMs = performance.now() - uploadStart;
      const drawStart = performance.now();

      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(textureLocation, 0);

      if (isWebGl2 && vao) {
        const gl2 = gl as WebGL2RenderingContext;
        gl2.bindVertexArray(vao);
        gl2.drawArrays(gl2.TRIANGLE_STRIP, 0, 4);
        gl2.bindVertexArray(null);
      } else {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      const drawMs = performance.now() - drawStart;
      return { backend: "webgl", uploadMs, drawMs };
    },
    destroy() {
      gl.deleteProgram(program);
      gl.deleteBuffer(buffer);
      gl.deleteTexture(texture);
      if (isWebGl2 && vao) {
        (gl as WebGL2RenderingContext).deleteVertexArray(vao);
      }
    }
  };
}

function createProgram(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string
): WebGLProgram | null {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertexShader || !fragmentShader) {
    return null;
  }

  const program = gl.createProgram();
  if (!program) {
    return null;
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  return program;
}

function compileShader(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) {
    return null;
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}