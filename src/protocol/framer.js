export class FrameDecoder {
  constructor({ maxFrameBytes = 8192 } = {}) {
    this.maxFrameBytes = maxFrameBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    const warnings = [];

    while (this.buffer.length) {
      const start = this.buffer.indexOf(0x40); // @
      if (start < 0) {
        if (this.buffer.length > this.maxFrameBytes) {
          warnings.push({ type: 'garbage', bytes: this.buffer.length });
          this.buffer = Buffer.alloc(0);
        }
        break;
      }
      if (start > 0) {
        warnings.push({ type: 'prefix', bytes: start });
        this.buffer = this.buffer.subarray(start);
      }
      const end = this.buffer.indexOf(0x23, 1); // #
      if (end < 0) {
        if (this.buffer.length > this.maxFrameBytes) {
          warnings.push({ type: 'oversize', bytes: this.buffer.length });
          this.buffer = this.buffer.subarray(1);
        }
        break;
      }
      const frame = this.buffer.subarray(0, end + 1);
      if (frame.length <= this.maxFrameBytes) frames.push(frame);
      else warnings.push({ type: 'oversize', bytes: frame.length });
      this.buffer = this.buffer.subarray(end + 1);
    }
    return { frames, warnings };
  }

  flush() {
    const pending = this.buffer;
    this.buffer = Buffer.alloc(0);
    return pending;
  }
}
