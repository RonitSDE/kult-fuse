import { DFlowEventSource } from '../src/adapters/event/dflow-event.mjs';
import fs from 'node:fs';
import { makeProbabilityMark } from '../src/core/probability.mjs';
const source=new DFlowEventSource({baseUrl:process.env.DFLOW_BASE_URL||'https://prediction-markets-api.dflow.net',apiKey:process.env.DFLOW_API_KEY,marketMint:process.env.DFLOW_MARKET_MINT});
const raw=await source.read();const mark=makeProbabilityMark(raw,{...JSON.parse(fs.readFileSync(process.env.POLICY_FILE||'./policy.example.json','utf8')),maxSpreadBps:Number(process.env.DFLOW_MAX_SPREAD_BPS||1200),maxOracleAgeSec:Number(process.env.DFLOW_MAX_AGE_SEC||20)});
console.log(JSON.stringify({source:raw.source,bid:raw.bid,ask:raw.ask,mark},null,2));
