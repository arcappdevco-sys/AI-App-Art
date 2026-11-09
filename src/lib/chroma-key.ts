export const RGB_LUMA_WEIGHTS = [0.2126, 0.7152, 0.0722] as const;

export type RgbColor = readonly [number, number, number];

export function applyMatteClip(alpha: number, clipBlack: number, clipWhite: number) {
  return Math.min(1, Math.max(0, (alpha - clipBlack) / (clipWhite - clipBlack)));
}

export function createMatteClipFilter(clipBlack: number, clipWhite: number) {
  if (clipBlack <= 0 && clipWhite >= 1) return null;
  const black = (clipBlack * 255).toFixed(4);
  const range = ((clipWhite - clipBlack) * 255).toFixed(4);
  return `format=gbrap,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip((alpha(X,Y)-${black})/${range}*255,0,255)',format=rgba`;
}

export function createMatteRefinementFilters(edgeChoke: number, edgeFeather: number) {
  const filters: string[] = [];
  const radius = Math.round(Math.abs(edgeChoke));
  const morphology = edgeChoke > 0 ? "erosion" : "dilation";
  for (let pass = 0; pass < radius; pass += 1) filters.push(morphology);
  if (edgeFeather > 0) filters.push(`boxblur=lr=${Math.round(edgeFeather)}:lp=3`);
  return filters;
}

function filterMatteLines(
  input: Uint8Array,
  output: Uint8Array,
  lineLength: number,
  lineCount: number,
  stride: number,
  lineStride: number,
  radius: number,
  dilate: boolean,
  queue: Int32Array,
) {
  for (let line = 0; line < lineCount; line += 1) {
    const offset = line * lineStride;
    let head = 0;
    let tail = 0;
    let next = 0;
    for (let position = 0; position < lineLength; position += 1) {
      const right = Math.min(lineLength - 1, position + radius);
      while (next <= right) {
        const value = input[offset + next * stride];
        while (tail > head) {
          const previous = input[offset + queue[tail - 1] * stride];
          if (dilate ? previous > value : previous < value) break;
          tail -= 1;
        }
        queue[tail] = next;
        tail += 1;
        next += 1;
      }
      const left = Math.max(0, position - radius);
      while (head < tail && queue[head] < left) head += 1;
      output[offset + position * stride] = input[offset + queue[head] * stride];
    }
  }
}

function blurMatteLines(
  input: Uint8Array,
  output: Uint8Array,
  lineLength: number,
  lineCount: number,
  stride: number,
  lineStride: number,
  radius: number,
) {
  for (let line = 0; line < lineCount; line += 1) {
    const offset = line * lineStride;
    let sum = 0;
    for (let position = -radius; position <= radius; position += 1) {
      const sample = Math.max(0, Math.min(lineLength - 1, position));
      sum += input[offset + sample * stride];
    }

    for (let position = 0; position < lineLength; position += 1) {
      if (position > 0) {
        const leaving = Math.max(0, position - radius - 1);
        const entering = Math.min(lineLength - 1, position + radius);
        sum -= input[offset + leaving * stride];
        sum += input[offset + entering * stride];
      }
      output[offset + position * stride] = Math.round(sum / (radius * 2 + 1));
    }
  }
}

export function refineMatte(
  matte: Uint8Array,
  scratch: Uint8Array,
  queue: Int32Array,
  width: number,
  height: number,
  edgeChoke: number,
  edgeFeather: number,
) {
  const radius = Math.round(Math.abs(edgeChoke));
  if (radius > 0) {
    const dilate = edgeChoke < 0;
    filterMatteLines(matte, scratch, width, height, 1, width, radius, dilate, queue);
    filterMatteLines(scratch, matte, height, width, width, 1, radius, dilate, queue);
  }

  const featherRadius = Math.round(edgeFeather);
  for (let pass = 0; pass < 3 && featherRadius > 0; pass += 1) {
    blurMatteLines(matte, scratch, width, height, 1, width, featherRadius);
    blurMatteLines(scratch, matte, height, width, width, 1, featherRadius);
  }
}

export function getKeyColorChroma(keyColor: RgbColor) {
  const luminance = keyColor[0] * RGB_LUMA_WEIGHTS[0]
    + keyColor[1] * RGB_LUMA_WEIGHTS[1]
    + keyColor[2] * RGB_LUMA_WEIGHTS[2];
  const vector: [number, number, number] = [
    keyColor[0] - luminance,
    keyColor[1] - luminance,
    keyColor[2] - luminance,
  ];
  const magnitudeSquared = vector[0] ** 2 + vector[1] ** 2 + vector[2] ** 2;
  return { vector, magnitudeSquared };
}

export function createMatteAwareSpillFilter(keyColor: RgbColor, strength: number) {
  const { vector, magnitudeSquared } = getKeyColorChroma(keyColor);
  if (magnitudeSquared < 0.001 || strength <= 0) return null;

  const channels = ["r(X,Y)", "g(X,Y)", "b(X,Y)"] as const;
  const format = (value: number) => value.toFixed(8);
  const luminance = `(${channels[0]}*${RGB_LUMA_WEIGHTS[0]}+${channels[1]}*${RGB_LUMA_WEIGHTS[1]}+${channels[2]}*${RGB_LUMA_WEIGHTS[2]})`;
  const projection = `max(0,((${channels[0]}-${luminance})*${format(vector[0])}+(${channels[1]}-${luminance})*${format(vector[1])}+(${channels[2]}-${luminance})*${format(vector[2])})/${format(magnitudeSquared)})`;
  const correctionLimits = vector.map((component, index) => {
    if (component > 0) return `(${channels[index]}/${format(component)})`;
    if (component < 0) return `((255-${channels[index]})/${format(-component)})`;
    return "1e9";
  });
  const maxCorrection = `min(${correctionLimits[0]},min(${correctionLimits[1]},${correctionLimits[2]}))`;
  const alpha = "(alpha(X,Y)/255)";
  const edgeWeight = `4*${alpha}*(1-${alpha})`;
  const correction = `min(${projection}*${format(strength)}*${edgeWeight},${maxCorrection})`;
  const outputNames = ["r", "g", "b"] as const;
  const output = channels.map((channel, index) => (
    `${outputNames[index]}='clip(${channel}-${format(vector[index])}*${correction},0,255)'`
  ));

  return `format=gbrap,geq=${output.join(":")}:a='alpha(X,Y)',format=rgba`;
}
