// Gürültü kapısı: ses eşiğin altındayken mikrofonu kısar. Ses iş parçacığında çalışır,
// bu yüzden sekme arka plandayken de (oyun oynarken) gecikmeden çalışmaya devam eder.

const HOLD = 0.3; // eşiğin altına indikten sonra kapının açık kaldığı süre (sn); kelime sonları kesilmesin
const ATTACK = 1 - Math.exp(-1 / (0.005 * sampleRate));
const RELEASE = 1 - Math.exp(-1 / (0.08 * sampleRate));
const REPORT = sampleRate / 20; // düzey göstergesi için saniyede 20 bildirim

class Gate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'threshold', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.gain = 0;
    this.hold = 0;
    this.peak = 0;
    this.since = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0][0];
    const output = outputs[0][0];
    if (!input) return true;

    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);

    if (rms >= parameters.threshold[0]) this.hold = HOLD * sampleRate;
    else this.hold -= input.length;
    const open = this.hold > 0;
    const step = open ? ATTACK : RELEASE;
    for (let i = 0; i < input.length; i++) {
      this.gain += ((open ? 1 : 0) - this.gain) * step;
      output[i] = input[i] * this.gain;
    }

    this.peak = Math.max(this.peak, rms);
    this.since += input.length;
    if (this.since >= REPORT) {
      this.port.postMessage({ level: this.peak, open });
      this.peak = this.since = 0;
    }
    return true;
  }
}

registerProcessor('gate', Gate);
