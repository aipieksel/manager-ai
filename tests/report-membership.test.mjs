import test from 'node:test';
import assert from 'node:assert/strict';
import {isChannelMember} from '../slack/report-membership.mjs';
test('membership follows pagination and distinguishes missing members',async()=>{
 const calls=[];const slack=async(method,args)=>{calls.push(args);assert.equal(method,'conversations.members');return args.cursor?{ok:true,members:['UMEMBER'],response_metadata:{next_cursor:''}}:{ok:true,members:['UOTHER'],response_metadata:{next_cursor:'page2'}};};
 assert.equal(await isChannelMember(slack,'CCHANNEL','UMEMBER'),true);assert.equal(calls.length,2);
 assert.equal(await isChannelMember(slack,'CCHANNEL','UABSENT'),false);
});
test('membership fails closed for API failure and repeated pagination',async()=>{
 await assert.rejects(isChannelMember(async()=>({ok:false}),'CCHANNEL','UMEMBER'),/membership_unavailable/);
 await assert.rejects(isChannelMember(async()=>({ok:true,members:[],response_metadata:{next_cursor:'same'}}),'CCHANNEL','UMEMBER'),/membership_unavailable/);
});
