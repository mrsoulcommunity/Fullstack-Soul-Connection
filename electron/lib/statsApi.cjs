'use strict';
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const PROTO_PATH = path.join(__dirname, 'proto', 'stats.proto');
let statsProto = null;

function loadProto() {
  if (statsProto) return statsProto;
  const def = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  statsProto = grpc.loadPackageDefinition(def).xray.app.stats.command;
  return statsProto;
}

class StatsClient {
  constructor(apiPort) {
    const proto = loadProto();
    this.client = new proto.StatsService(
      `127.0.0.1:${apiPort}`,
      grpc.credentials.createInsecure(),
      { 'grpc.max_receive_message_length': 8 * 1024 * 1024 }
    );
  }

  // Returns cumulative { uplink, downlink } byte counts for the given
  // outbound tag since the process started (reset=false -- we compute our
  // own deltas locally rather than consuming Xray's counters).
  queryOutboundTraffic(tag, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + timeoutMs);
      this.client.QueryStats(
        { pattern: `outbound>>>${tag}>>>traffic>>>`, reset: false },
        { deadline },
        (err, res) => {
          if (err) return reject(err);
          let uplink = 0;
          let downlink = 0;
          for (const stat of res.stat || []) {
            if (stat.name.endsWith('>>>uplink')) uplink = Number(stat.value) || 0;
            else if (stat.name.endsWith('>>>downlink')) downlink = Number(stat.value) || 0;
          }
          resolve({ uplink, downlink });
        }
      );
    });
  }

  close() {
    try { this.client.close(); } catch { /* ignore */ }
  }
}

module.exports = { StatsClient };
