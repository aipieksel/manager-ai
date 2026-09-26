'use client';
import { useEffect, useState } from 'react';
type ReportSettings = {configuration:Record<string,string|number>|null;userIds:string[];channelIds:string[];memberChannelIds?:string[]};
const fields = [
  ['projectId','project_id','Project ID'],['installationId','installation_id','Slack installation ID'],['apiAppId','api_app_id','Slack app ID'],
  ['executorId','executor_id','Report executor ID'],['executorVersionId','executor_version_id','Executor version ID'],
  ['referenceId','reference_id','Reference workbook ID'],['referenceSha256','reference_sha256','Reference SHA-256'],['sourceConfigId','source_config_id','Source configuration ID'],
];
export function ReportSettingsPanel({notify}:{notify:(message:string)=>void}) {
  const [data,setData]=useState<ReportSettings>({configuration:null,userIds:[],channelIds:[]});
  const [editing,setEditing]=useState(false),[busy,setBusy]=useState(false),[unavailable,setUnavailable]=useState(false);
  useEffect(()=>{let cancelled=false;void fetch('/api/slack/reports').then(async r=>{if(!r.ok)throw Error();return r.json();}).then(d=>{if(!cancelled)setData(d);}).catch(()=>{if(!cancelled)setUnavailable(true);});return()=>{cancelled=true;};},[]);
  async function send(body:unknown) {
    const response=await fetch('/api/slack/reports',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Report settings could not be saved');
    const refreshed=await fetch('/api/slack/reports');if(!refreshed.ok)throw Error('Saved; refresh settings to verify');setData(await refreshed.json());
  }
  async function save(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault();const form=new FormData(event.currentTarget);setBusy(true);
    const configuration:Record<string,unknown>=Object.fromEntries(fields.map(([key])=>[key,String(form.get(key)||'').trim()]));
    for(const key of ['userIds','channelIds','memberChannelIds'])configuration[key]=String(form.get(key)||'').split(/[\s,]+/).filter(Boolean);
    try{await send({action:'save_draft',configuration});setEditing(false);notify('Report draft saved. Report generation remains disabled.');}
    catch(error){notify(error instanceof Error?error.message:'Report settings could not be saved');}finally{setBusy(false);}
  }
  return <section className="panel" id="slack-report-settings">
    <div className="panel-head"><div><h2>AI referral reports</h2><span>{unavailable?'Report settings are unavailable. Apply the report migration before setup.':data.configuration?.enabled?'Enabled':'Disabled'} · Standard six-sheet Website workbook</span></div>
      <button id="slack-report-configure" disabled={unavailable} onClick={()=>setEditing(true)}>Configure report access</button></div>
    <div className="approval-card"><p>Report access allows only the standard workbook request. It does not grant access to general agents. Drafts remain disabled until deployment verification is complete.</p>
    <div className="drawer-actions">{data.configuration&&data.configuration.enabled!==1&&<button className="primary-button" id="slack-report-enable" disabled={busy} onClick={async()=>{setBusy(true);try{await send({action:'validate_enable'});notify('Runtime verified; AI referral reports enabled');}catch(error){notify(error instanceof Error?error.message:'Runtime verification failed');}finally{setBusy(false);}}}>Verify runtime and enable reports</button>}
    {data.configuration?.enabled===1&&<button className="secondary-button" id="slack-report-disable" disabled={busy} onClick={async()=>{setBusy(true);try{await send({action:'disable'});notify('AI referral reports disabled');}catch{notify('Could not disable reports');}finally{setBusy(false);}}}>Disable reports</button>}
    </div></div>
    {editing&&<div className="ops-modal-backdrop" onMouseDown={()=>setEditing(false)}><form className="ops-modal" id="slack-report-form" onSubmit={save} onMouseDown={e=>e.stopPropagation()}>
      <div className="ops-modal-head"><h2>Report-only access</h2><button type="button" aria-label="Close report settings" onClick={()=>setEditing(false)}>×</button></div>
      {fields.map(([key,column,label])=><label key={key} htmlFor={`slack-report-${key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}`}>{label}<input id={`slack-report-${key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}`} name={key} required defaultValue={String(data.configuration?.[column]||'')} autoComplete="off"/></label>)}
      <label htmlFor="slack-report-users">Allowed report users<textarea id="slack-report-users" name="userIds" rows={3} defaultValue={data.userIds.join('\n')} placeholder="One Slack user ID per line"/></label>
      <label htmlFor="slack-report-channels">Allowed report channels<textarea id="slack-report-channels" name="channelIds" required rows={3} defaultValue={data.channelIds.join('\n')} placeholder="One internal Slack channel ID per line"/></label>
      <label htmlFor="slack-report-member-channels">Channels where every member can generate reports<textarea id="slack-report-member-channels" name="memberChannelIds" rows={3} defaultValue={(data.memberChannelIds??[]).join('\n')} placeholder="One allowed report channel ID per line"/><small>Current membership is checked for each request and again before delivery. Leave blank to use only the listed users.</small></label>
      <div className="drawer-actions"><button type="button" onClick={()=>setEditing(false)}>Cancel</button><button className="primary-button" disabled={busy}>{busy?'Saving…':'Save disabled draft'}</button></div>
    </form></div>}
  </section>;
}
