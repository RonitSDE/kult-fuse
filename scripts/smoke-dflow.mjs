import { DFlowEventSource } from '../src/adapters/event/dflow-event.mjs';
import { defaultDemoPolicy } from '../src/core/policy.mjs';
import { makeProbabilityMark } from '../src/core/probability.mjs';
const source=new DFlowEventSource({baseUrl:process.env.DFLOW_BASE_URL||'https://dev-prediction-markets-api.dflow.net',apiKey:process.env.DFLOW_API_KEY,marketMint:process.env.DFLOW_MARKET_MINT});
const raw=await source.read();const mark=makeProbabilityMark(raw,{...defaultDemoPolicy(),maxSpreadBps:Number(process.env.DFLOW_MAX_SPREAD_BPS||1200),maxOracleAgeSec:Number(process.env.DFLOW_MAX_AGE_SEC||20)});
console.log(JSON.stringify({source:raw.source,bid:raw.bid,ask:raw.ask,mark},null,2));
