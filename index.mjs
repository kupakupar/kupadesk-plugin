import {initialize} from './boot.mjs';
export default async function KupaDesk(input,options={}) {
  try {await initialize(input,options);}
  catch {try {await input?.client?.app?.log?.({body:{service:'kupadesk-loader',level:'warn',message:'private_core_unavailable'}});}catch {}}
  return {};
}
