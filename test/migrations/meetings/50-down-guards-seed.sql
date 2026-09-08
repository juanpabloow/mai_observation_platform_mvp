
INSERT INTO tenants (id,name) VALUES ('11111111-1111-1111-1111-111111111111','T');
INSERT INTO clients (id,tenant_id,name) VALUES ('aaaa0001-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','C');
INSERT INTO meetings (id,tenant_id,client_id,title,source_kind,idempotency_key)
  VALUES ('dead0001-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','aaaa0001-0000-0000-0000-000000000000','R','file','k');
INSERT INTO meeting_processing_runs (id,tenant_id,client_id,meeting_id,run_number,trigger)
  VALUES ('beef0001-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','aaaa0001-0000-0000-0000-000000000000','dead0001-0000-0000-0000-000000000000',1,'initial');
INSERT INTO meeting_processing_jobs (id,tenant_id,client_id,meeting_id,run_id,stage)
  VALUES ('cafe0001-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','aaaa0001-0000-0000-0000-000000000000','dead0001-0000-0000-0000-000000000000','beef0001-0000-0000-0000-000000000000','transcribe');
INSERT INTO meeting_transcript_versions (id,tenant_id,client_id,meeting_id,run_id,whisper_model,duration_seconds,segment_count,schema_version)
  VALUES ('fade0001-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','aaaa0001-0000-0000-0000-000000000000','dead0001-0000-0000-0000-000000000000','beef0001-0000-0000-0000-000000000000','medium',10,1,1);
INSERT INTO worker_pools (id,slug,environment,scope,tenant_id)
  VALUES ('0be10001-0000-0000-0000-000000000000','pool-lan','development','single_tenant','11111111-1111-1111-1111-111111111111');
INSERT INTO worker_credentials (id,pool_id,label,token_hash,token_prefix)
  VALUES ('0c7e0001-0000-0000-0000-000000000000','0be10001-0000-0000-0000-000000000000','c',repeat('a',64),'mtk_1111');
INSERT INTO meeting_result_uploads (tenant_id,client_id,meeting_id,job_id,attempt,kind,schema_version,storage_key)
  VALUES ('11111111-1111-1111-1111-111111111111','aaaa0001-0000-0000-0000-000000000000','dead0001-0000-0000-0000-000000000000','cafe0001-0000-0000-0000-000000000000',0,'transcript',1,'r/a');
