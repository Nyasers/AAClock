// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * glsl-tokenizer 2.1.5 不带类型声明，上游也没有 @types 包，这里只声明本项目用到的那个入口。
 * `data` 是记号在源码里的原字面，`position` 是它的字符偏移——压缩器靠这两个字段判断
 * 哪些记号在源码里本来就是挨着的（`<<`、`+=` 会被切成两个记号）。
 */
declare module 'glsl-tokenizer/string' {
  export interface GlslToken {
    type: string;
    data: string;
    position: number;
    line: number;
    column: number;
  }

  export default function tokenizeGlsl(source: string): GlslToken[];
}
