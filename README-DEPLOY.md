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
2. **Storage → New Network Volume**: ขนาด **200GB** (โมเดลรวม ~128GB ต้องเผื่อที่ว่าง) เลือก datacenter ที่มี GPU ใหญ่ว่าง (ดูข้อ 5)
3. เอาโมเดลขึ้น volume: **Pods → Deploy** pod ชั่วคราว (GPU ถูกสุดก็ได้ ใช้แค่เป็นทางผ่าน) โดย attach volume ที่สร้าง → เปิด JupyterLab/terminal แล้วสร้างโครงสร้างนี้ใน volume:

   | ไฟล์ | โฟลเดอร์ปลายทาง | ขนาด | ใช้กับ |
   |---|---|---|---|
   | `flux1-dev.safetensors` | `models/diffusion_models/` | 22.2 GB | Upscale |
   | `t5xxl_fp16.safetensors` | `models/clip/` | 9.1 GB | Upscale |
   | `clip_l.safetensors` | `models/clip/` | 0.2 GB | Upscale |
   | `ae.safetensors` | `models/vae/` | 0.3 GB | Upscale |
   | `RealESRGAN_x4plus.pth` | `models/upscale_models/` | 0.1 GB | Upscale |
   | `flux2-dev.safetensors` | `models/diffusion_models/` | **60.0 GB** | Skp→Render |
   | `mistral_3_small_flux2_bf16.safetensors` | `models/text_encoders/` | 33.1 GB | Skp→Render |
   | `full_encoder_small_decoder.safetensors` | `models/vae/` | 0.2 GB | Skp→Render |
   | `Flux_2-Turbo-LoRA_comfyui.safetensors` | `models/loras/` | 2.6 GB | Skp→Render |

   **รวม ~128 GB** (Upscale 31.9 GB + Skp→Render 95.9 GB) — โครงสร้างโฟลเดอร์เหมือน `ComfyUI/models/` ในเครื่องเป๊ะ คัดลอกได้ 1:1

   ⚠️ **อย่าอัปโหลดจากเครื่องตัวเอง** ถ้าเลี่ยงได้ — 101GB ที่ความเร็วอัปโหลดบ้าน 50 Mbps ใช้เวลา ~4.5 ชั่วโมง แต่ถ้า **ดาวน์โหลดจาก Hugging Face เข้า pod โดยตรง** จะวิ่งที่ความเร็ว datacenter (มักเกิน 1 Gbps) เหลือ ~15–30 นาที ใช้ `wget <URL> -O <ปลายทาง>` ใน terminal ของ pod โดยหา URL จากหน้า Hugging Face ของแต่ละโมเดล (ไฟล์ที่โหลดมาจากที่ไหน ก็โหลดจากที่เดิม) เฉพาะไฟล์ที่หาบน HF ไม่ได้ค่อยอัปโหลดจากเครื่อง

   เสร็จแล้ว **terminate pod** (volume อยู่ต่อ ไม่หาย)
4. **Serverless → New Endpoint → Import Git Repository** → เชื่อม GitHub → เลือก repo `tripel-s-ai` → Dockerfile path: `worker/Dockerfile` (RunPod จะ build image ให้เอง ไม่ต้องมี Docker ในเครื่อง)
5. ตั้งค่า endpoint:
   - **GPU**: SSS Upscale (flux1-dev 22GB + t5xxl 9GB ≈ 32GB) ใช้ **48GB (L40S/A6000)** ได้สบาย
     ⚠️ SSS Sketchup to Render ต้องโหลด flux2-dev (60GB) + mistral (33GB) = **~93GB น้ำหนักโมเดล ซึ่งเกินความจุ GPU 80GB (H100)** จึงต้องเลือกอย่างใดอย่างหนึ่ง: ใช้ GPU ที่ใหญ่กว่า (H200 141GB / B200) ซึ่งแพงกว่ามาก, หรือยอมให้ ComfyUI offload บางส่วนลง system RAM ซึ่งทำงานได้แต่ช้าลงชัดเจน, หรือกลับไปใช้ `flux2_dev_fp8mixed` (33GB) ที่รวมแล้วเหลือ ~66GB พอดีกับ H100 80GB
   - **Network Volume**: เลือก volume จากข้อ 2
   - **Max Workers**: 1–2 (กันค่าใช้จ่ายบาน) · **Execution Timeout**: 900s
   - **Idle Timeout**: ตั้ง **60–120 วินาที** (ไม่ใช่ 5s) — การโหลดโมเดล 66GB จาก network volume เข้า VRAM กินเวลา 1–5 นาทีต่อ cold start ถ้า worker ดับทุกครั้งที่ว่าง ผู้ใช้จะรอนานมากทุกครั้ง การเปิดค้างไว้ครู่หนึ่งแลกกับค่า GPU เพิ่มเล็กน้อยคุ้มกว่ามาก
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
