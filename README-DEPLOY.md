# Tripel S AI — คู่มือ Deploy ระบบจริง

สถาปัตยกรรม:

```
ผู้ใช้ → เว็บ (Vercel: web/) → Supabase (ล็อกอิน + เครดิต + เก็บรูป)
                              → RunPod Serverless (worker/: รัน ComfyUI)
```

ต้องสมัคร 3 บริการ (เรียงตามลำดับที่ควรทำ): **Supabase → RunPod → Vercel**

---

## A. Supabase (~10 นาที)

1. สมัคร/ล็อกอินที่ https://supabase.com → **New project** (ตั้งชื่อ เช่น `tripel-s-ai`, เลือก region Singapore)
2. เมนู **SQL Editor** → New query → คัดลอกเนื้อหาไฟล์ [`supabase/schema.sql`](supabase/schema.sql) ทั้งหมดไปวาง → **Run**
   (สร้างตาราง profiles/jobs, ระบบเครดิต, และ storage buckets ให้ครบในคลิกเดียว)
3. เมนู **Authentication → Sign In / Up**:
   - Email: เปิดอยู่แล้วโดย default
   - Google: เปิดเมื่อพร้อม (ต้องสร้าง OAuth Client ใน Google Cloud Console ก่อน — ข้ามไปก่อนได้ ใช้ email/password ไปพลาง)
4. เมนู **Project Settings → API** จดค่า 3 ตัว:
   - `Project URL` → ใช้เป็น `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (**ลับ** — ห้ามใส่ในโค้ด/frontend)

## B. RunPod (~30–60 นาที ไม่รวมเวลาอัปโหลดโมเดล)

1. สมัครที่ https://runpod.io → เติมเงิน (เริ่ม $10–25 พอทดสอบ)
2. **Storage → New Network Volume**: ขนาด ~100GB เลือก datacenter ที่มี GPU 24–48GB ว่าง
3. อัปโหลดโมเดลเข้า volume: **Pods → Deploy** pod ชั่วคราว (GPU ถูกสุดก็ได้) โดย attach volume ที่สร้าง → เปิด terminal/JupyterLab แล้วจัดโฟลเดอร์ในไดรฟ์ volume ให้เป็นแบบนี้ (ดาวน์โหลดด้วย `wget`/`huggingface-cli` หรืออัปโหลดจากเครื่อง):

   ```
   models/
   ├── unet/flux1-dev-fp8.safetensors
   ├── unet/flux2_dev_fp8mixed.safetensors
   ├── clip/t5xxl_fp8_e4m3fn.safetensors
   ├── clip/clip_l.safetensors
   ├── clip/mistral_3_small_flux2_bf16.safetensors
   ├── vae/ae.safetensors
   ├── vae/full_encoder_small_decoder.safetensors
   ├── loras/Flux_2-Turbo-LoRA_comfyui.safetensors
   └── upscale_models/4x-UltraSharp.pth
   ```

   (ไฟล์ชุดเดียวกับที่ใช้ใน ComfyUI บนเครื่องตอนนี้ — คัดลอกจาก `ComfyUI/models/...` ได้เลย)
   เสร็จแล้ว **terminate pod** (volume อยู่ต่อ ไม่หาย)
4. **Serverless → New Endpoint → Import Git Repository** → เชื่อม GitHub → เลือก repo `tripel-s-ai` → Dockerfile path: `worker/Dockerfile` (RunPod จะ build image ให้เอง ไม่ต้องมี Docker ในเครื่อง)
5. ตั้งค่า endpoint:
   - **GPU**: 24GB (RTX 4090) ขึ้นไป — งาน Flux.2 แนะนำ 48GB (L40S/A6000)
   - **Network Volume**: เลือก volume จากข้อ 2
   - **Max Workers**: 1–2 (กันค่าใช้จ่ายบาน) · **Idle Timeout**: 5s · **Execution Timeout**: 900s
6. จดค่า:
   - **Endpoint ID** (หน้า endpoint) → `RUNPOD_ENDPOINT_ID`
   - **API key** (Settings → API Keys → Create) → `RUNPOD_API_KEY`

## C. Vercel (~10 นาที)

1. สมัครที่ https://vercel.com ด้วยบัญชี GitHub → **Add New → Project** → import repo `tripel-s-ai`
2. **Root Directory**: เลือก `web` (สำคัญ!)
3. **Environment Variables** ใส่ครบ 5 ตัว (ดูรายชื่อใน [`web/.env.example`](web/.env.example))
4. **Deploy** → ได้ URL เช่น `https://tripel-s-ai.vercel.app`
5. กลับไป Supabase → **Authentication → URL Configuration** → ตั้ง Site URL เป็น URL ของ Vercel (จำเป็นสำหรับ Google OAuth redirect)

## D. ทดสอบ

1. เปิดเว็บ Vercel → Sign in ด้วย email+password ใหม่ (ระบบสร้างบัญชี + แจกเครดิตฟรี 20 อัตโนมัติ)
2. Dashboard → อัปโหลดรูป → Run Workflow
3. ครั้งแรกจะช้า (cold start โหลดโมเดล ~1–2 นาที) ครั้งถัดไปเร็วขึ้น
4. ถ้า fail: ดู log ใน RunPod Console → endpoint → Requests แล้วส่ง error มาให้ Claude ช่วย debug

## หมายเหตุ

- เว็บเดิมบน GitHub Pages (`peetzaz62-tech.github.io/tripel-s-ai`) ยังเป็นเวอร์ชัน demo — เมื่อ Vercel ใช้งานได้แล้วค่อยปิดหรือ redirect
- เครดิต: Free 20 หน่วย/ผู้ใช้ (ตั้งใน `supabase/schema.sql`), งานละ 1 เครดิต (ตั้งใน `web/app/api/generate/route.js` → `CREDIT_COST`), งาน fail คืนเครดิตอัตโนมัติ
- ระบบจ่ายเงินยังไม่ต่อ — โครงเครดิตพร้อมแล้ว เมื่อเลือก gateway ได้ (Opn/Lemon Squeezy) ต่อเพิ่มได้เลย
- prompt สูตรทั้งหมดอยู่ฝั่ง server (`web/lib/prompts.mjs`) ผู้ใช้มองไม่เห็นแล้ว
