#!/usr/bin/env python3
"""Record an operator's review AFTER inspecting all six generated previews.

This command does not perform visual review automatically. Its signing secret
stays outside the generation sandbox. It never modifies the workbook.
"""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
from datetime import datetime, timezone
from reports import ReportRuntime
from report_package import SHEETS, verify_package


def record_review(runtime, run_id, reviewer):
    config=runtime.config();state=runtime.state(run_id)
    if not state or state.get('status')!='waiting_for_review':raise ValueError('report_not_awaiting_review')
    work=runtime.directory(run_id)/'work'
    if work.is_symlink():raise ValueError('unsafe_report_path')
    candidate_path=work/'candidate.json'
    if candidate_path.is_symlink():raise ValueError('unsafe_report_path')
    candidate=json.loads(candidate_path.read_text());meta=candidate['artifact'];filename=meta['filename']
    if Path(filename).name!=filename:raise ValueError('invalid_report_artifact')
    file=work/filename
    if file.is_symlink() or not file.is_file() or file.stat().st_size>25*1024*1024:raise ValueError('invalid_report_artifact')
    data=file.read_bytes()
    if hashlib.sha256(data).hexdigest()!=meta['sha256']:raise ValueError('invalid_report_artifact')
    verify_package(data,candidate['metrics'])
    previews={}
    for sheet in SHEETS:
        image=work/'previews'/(sheet.replace(' ','-')+'.png')
        if image.is_symlink() or image.parent.is_symlink() or not image.is_file() or image.stat().st_size>20*1024*1024:raise ValueError('review_preview_unavailable')
        preview=image.read_bytes()
        if not preview.startswith(b'\x89PNG\r\n\x1a\n'):raise ValueError('review_preview_unavailable')
        previews[sheet]=hashlib.sha256(preview).hexdigest()
    evidence_id='evidence_'+hashlib.sha256((run_id+meta['sha256']).encode()).hexdigest()[:40]
    review=dict(runId=run_id,sha256=meta['sha256'],status='passed',sheets=SHEETS,evidenceId=evidence_id,reviewer=reviewer,reviewedAt=datetime.now(timezone.utc).isoformat(),previewSha256=previews)
    signature=hmac.new(config['reviewSecret'].encode(),json.dumps(review,sort_keys=True,separators=(',',':')).encode(),hashlib.sha256).hexdigest()
    root=Path(config['reviewEvidenceDirectory'])
    if not root.is_absolute() or root.resolve()!=root:raise ValueError('unsafe_review_path')
    root.mkdir(mode=0o700,exist_ok=True)
    if root.stat().st_mode&0o077 or root.stat().st_uid!=os.getuid():raise ValueError('unsafe_review_path')
    target=root/(run_id+'.json')
    fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as output:
        json.dump({'review':review,'signature':signature},output);output.flush();os.fsync(output.fileno())
    return evidence_id


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir',required=True);parser.add_argument('--config',required=True);parser.add_argument('--run-id',required=True)
    parser.add_argument('--reviewer',required=True);parser.add_argument('--all-six-previews-inspected',action='store_true',required=True)
    args=parser.parse_args()
    if not 1<=len(args.reviewer)<=120:parser.error('reviewer must contain 1 to 120 characters')
    print(record_review(ReportRuntime(args.state_dir,args.config),args.run_id,args.reviewer))
