export const API_URL=process.env.EXPO_PUBLIC_API_URL||'http://localhost:4000';
let jwtToken:string|null=null;
export function setToken(token:string|null){jwtToken=token;}
export async function api<T>(path:string,init:RequestInit={}):Promise<T>{
  const response=await fetch(`${API_URL}${path}`,{...init,headers:{'Content-Type':'application/json',...(jwtToken?{Authorization:`Bearer ${jwtToken}`}:{ }),...init.headers}});
  if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error||`HTTP ${response.status}`);}
  if(response.status===204)return undefined as T;
  return response.json() as Promise<T>;
}
