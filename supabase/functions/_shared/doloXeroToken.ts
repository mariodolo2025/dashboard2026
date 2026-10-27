/** Shared refresh lease + compare-and-swap. No financial sync behaviour lives here. */
export async function getXeroAccessToken(supabase: any): Promise<{accessToken:string;tenantId:string;scopes:string}> {
  const lease=crypto.randomUUID();
  for(let attempt=0;attempt<40;attempt++) {
    const {data:claim,error}=await supabase.rpc('dolo_balance_xero_claim',{p_lease:lease});
    if(error) throw new Error('Xero session coordination unavailable');
    if(claim?.accessToken) return claim;
    if(claim?.busy) { await new Promise(r=>setTimeout(r,750)); continue; }
    if(!claim?.refreshToken) throw new Error('Xero is not connected');
    let refreshed=false;
    try {
      const res=await fetch('https://identity.xero.com/connect/token',{
        method:'POST',headers:{Authorization:`Basic ${btoa(`${Deno.env.get('XERO_CLIENT_ID')}:${Deno.env.get('XERO_CLIENT_SECRET')}`)}`,'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'refresh_token',refresh_token:claim.refreshToken}),signal:AbortSignal.timeout(20000),
      });
      if(!res.ok) throw new Error(`Xero connection needs attention (token HTTP ${res.status})`);
      const token=await res.json();
      if(typeof token.access_token!=='string'||!token.access_token||typeof token.refresh_token!=='string'||!token.refresh_token||!Number.isInteger(token.expires_in)||token.expires_in<=0) throw new Error('Xero token response invalid');
      refreshed=true;
      const args={p_lease:lease,p_old_refresh:claim.refreshToken,p_new_refresh:token.refresh_token,p_access:token.access_token,p_expires:token.expires_in,p_scopes:token.scope??''};
      // Retry transport failures with the SAME rotated token, never refresh again.
      let result=await supabase.rpc('dolo_balance_xero_finish',args);
      if(result.error) result=await supabase.rpc('dolo_balance_xero_finish',args);
      if(result.error) throw new Error('Xero rotated session could not be persisted');
      if(!result.data) continue; // A newer OAuth connection won the compare-and-swap.
      return {accessToken:token.access_token,tenantId:claim.tenantId,scopes:token.scope??''};
    } finally {
      // After rotation leave a failed persistence lease to expire; avoid immediate repeat refresh.
      if(!refreshed) await supabase.rpc('dolo_balance_xero_release',{p_lease:lease});
    }
  }
  throw new Error('Xero connection is busy; retry shortly');
}
