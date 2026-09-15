#version 300 es
precision highp float;

// 无属性：用 gl_VertexID 拼一个盖住整个裁剪空间的大三角形（配空 VAO）。
void main() {
  vec2 v = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
}
