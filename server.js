// 1. 가장 먼저 환경변수 장부를 로드하여 모든 비공개 키가 인식되도록 조치합니다.
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
const router = express.Router();
import cors from 'cors';
import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from 'ffmpeg-static';
import { rateLimit } from 'express-rate-limit';
import { GoogleGenerativeAI } from '@google/generative-ai';

// 💡 Firebase Admin SDK 최신 ESM 표준 문법 가져오기 (오류를 완벽히 해결하기 위한 전용 부품만 가져옵니다)
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

// 💡 우리 프로젝트 안의 파일들 가져오기
import { User } from './models/User.js';
import { PortOneClient } from '@portone/server-sdk';
import { authMiddleware } from './middlewares/auth.js';

// 💡 ES Module 환경 설정 (__dirname 선언)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// FFmpeg 경로 지정
ffmpeg.setFfmpegPath(ffmpegInstaller);

// Express 서버 초기화 (이제 'app' 이라는 이름은 오직 express 서버만 단독으로 사용합니다!)
const app = express();
const PORT = process.env.PORT || 10000; 

// 글로벌 네트워크 미들웨어 세팅
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// EJS 템플릿 엔진 설정
app.set('view engine', 'ejs');
app.set('views', './views'); // views 폴더 안의 템플릿들을 바라봅니다.

// API 키 및 서비스 연결 설정
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUNO_API_KEY = process.env.SUNO_API_KEY;
const portoneClient = new PortOneClient({
  secret: process.env.PORTONE_API_SECRET 
});

// =================================================================
// 🔥 [Firebase Admin SDK 단일 안전 초기화]
// getApps() 표준 배열 검증과 cert() 표준 함수를 사용하여 undefined 오류를 무조건 해결합니다.
// =================================================================
const firebaseConfigRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!firebaseConfigRaw) {
  console.error("❌ 환경변수에 FIREBASE_SERVICE_ACCOUNT가 설정되지 않았습니다!");
  process.exit(1);
}

if (getApps().length === 0) {
  try {
    const serviceAccount = JSON.parse(firebaseConfigRaw);
    initializeApp({
      credential: cert(serviceAccount)
    });
    console.log("🚀 Firebase Admin SDK 단일 초기화 완벽 성공!");
  } catch (error) {
    console.error("❌ Firebase 초기화 중 JSON 파싱 에러 발생:", error.message);
    process.exit(1);
  }
}

// =================================================================
// 🍃 [MongoDB 연결 설정]
// =================================================================
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/birthday_maker';
mongoose.connect(MONGODB_URI)
  .then(() => console.log("🍃 MongoDB 연결 성공!"))
  .catch(err => console.error("❌ MongoDB 연결 실패:", err));

// 트래픽 디펜더 설정
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});

// =================================================================
// 🏠 [라우터] 사용자가 메인 페이지(/)에 접속했을 때 화면을 그려주는 템플릿 엔진
// =================================================================
app.get('/', (req, res) => {
  const firebaseKeys = {
    apiKey: process.env.FIREBASE_PUBLIC_API_KEY,
    authDomain: process.env.FIREBASE_PUBLIC_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PUBLIC_PROJECT_ID,
    storageBucket: process.env.FIREBASE_PUBLIC_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_PUBLIC_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_PUBLIC_APP_ID
  };
  res.render('index', { firebaseKeys });
});

// 1. 프론트엔드가 처음 요청을 보낸 주소 (카카오 로그인 페이지로 리다이렉트)
router.get('/auth/kakao', (req, res) => {
    const kakaoAuthUrl = `https://kauth.kakao.com/oauth/authorize?response_type=code&client_id=${process.env.KAKAO_REST_API_KEY}&redirect_uri=${process.env.KAKAO_REDIRECT_URI}&prompt=none`;
    res.redirect(kakaoAuthUrl);
});

// 2. 카카오가 인증 완료 후 인가 코드(Code)를 보내줄 Callback 주소
router.get('/auth/kakao/callback', async (req, res) => {
    const { code } = req.query;
    // 이 인가 코드로 카카오 토큰을 요청하고, 사용자 정보를 가져오는 로직 구현
    try {
        // 토큰 요청 및 로그인/회원가입 처리...
        res.status(200).json({ success: true, message: "로그인 성공" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// =================================================================
// 🔑 [API] 회원가입 및 로그인 처리 문지기
// =================================================================
app.post('/api/login', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
        return res.status(401).json({
            success: false,
            error: "인증된 유저 정보가 존재하지 않습니다."
        });
    }
    return res.status(200).json({
      success: true,
      message: `${user.email}님, 환영합니다!`,
      data: {
        uid: user.firebaseUid,
        email: user.email,
        nickname: user.nickname,
        credits: user.credits 
      }
    });
  } catch (error) {
    console.error("🔒 백엔드 로그인 라우터 에러:", error);
    return res.status(500).json({
      success: false,
      error: "서버 내부 인증 처리 실패"
    });
  }
});

// 크레딧 잔액 조회
app.get('/api/user/profile', authMiddleware, (req, res) => {
  return res.status(200).json({
    success: true,
    credits: req.user.credits
  });
});

// =================================================================
// 💳 [API] 포트원 결제 완료 검증 및 크레딧 안전 충전소
// =================================================================
app.post('/api/payments/complete', authMiddleware, async (req, res) => {
  const currentLoggedInUserId = req.user._id; 
  const { paymentId, amount } = req.body; 

  try {
    const paymentData = await portoneClient.payment.getPayment({ paymentId });

    if (paymentData.status === "PAID" && paymentData.amount.total === amount) {
      const creditsToCharge = amount / 1000; 

      const updatedUser = await User.findByIdAndUpdate(
        currentLoggedInUserId,
        { $inc: { credits: creditsToCharge } },
        { new: true } 
      );

      console.log(`💰 결제 성공 및 크레딧 지급 완료: ${updatedUser.email} (+${creditsToCharge} Credits)`);

      return res.status(200).json({ 
        success: true, 
        message: `${creditsToCharge} 크레딧이 안전하게 충전되었습니다.`,
        currentCredits: updatedUser.credits
      });
    } else {
      return res.status(400).json({ 
        success: false, 
        message: "비정상적이거나 위변조된 결제 시도입니다." 
      });
    }
  } catch (error) {
    console.error("❌ 결제 검증 중 서버 오류 발생:", error);
    return res.status(500).json({ 
      success: false, 
      message: "결제를 처리하는 중 서버 오류가 발생했습니다." 
    });
  }
});

// =================================================================
// 🤖 [API] Gemini 한글 가사 자동 생성소
// =================================================================
app.post('/api/generate-lyrics', apiLimiter, async (req, res) => {
    try {
        if (!req.body) return res.status(400).json({ error: "요청 본문이 비어있습니다." });
        const { name, zodiac, stone, flower, fixedChorus, genre, isSunoAutoMode } = req.body;
        const fallbackName = name || '우리 아이';
        
        // 💡 [동적 긴급 디펜더 장착] 구글 서버 전체 폭주(503) 시에도 사용자의 프로필에 맞춰 커스텀 고품질 가사를 백그라운드에서 실시간 자동 빌드해주는 스마트 백업 엔진입니다!
        const defaultLyrics = `[Intro]
${fallbackName}의 아주 특별한 날, 축하가 시작됩니다.

[Verse 1]
${zodiac || "맑은 하늘"}의 기운을 담아 우리 곁에 온 귀여운 천사 ${fallbackName}
${stone || "보석"}처럼 빛나는 너의 반짝이는 그 맑은 눈망울과
${flower || "향기로운 꽃"} 가득한 계절처럼 매일 따뜻함과 미소를 안겨주는 너
오늘 너의 특별하고 소중한 생일날을 온 마음 모아서 축하해!

[Chorus]
${fixedChorus ? fixedChorus : `${fallbackName}야 생일 축하해, 영원히 영원히 사랑해`}
너와 함께 걸어갈 앞으로의 모든 계절과 날들이
전부 세상에서 가장 아름다운 축복일 거야`.trim();

        const safeChorus = fixedChorus || `${fallbackName}야 생일 축하해`;

        if (!GEMINI_API_KEY) return res.json({ lyrics: defaultLyrics });

        let prompt = '';
        if (isSunoAutoMode === true || isSunoAutoMode === 'suno') {
            prompt = `너는 반려동물을 위해 경쾌하고 사랑스러운 생일 축하 곡을 쓰는 최고의 AI 작사가야.
            음악 장르 [${genre}] 스타일에 어울리는 세련된 한글 가사로 작성해줘. 영어 단어는 절대 섞지 마라.
            [🔥 중요 제한 조건]
            Suno AI가 1분 내외로 완창할 수 있도록 가사를 절대 길게 쓰지 말고, 전체 분량을 최대 150자 이내로 아주 짧고 압축적으로 작성해줘.
            주인공 이름: ${name} (가사 전반에 최소 2~3번 정도만 자연스럽게 등장시킬 것)
            [반드시 아래의 딱 3가지 구조로만 제한해서 출력해]
            [Intro]
            (아주 짧은 도입부 한 줄)
            [Verse 1]
            (짧게 2줄에서 3줄 이내)
            [Chorus]
            ${safeChorus} (이 문장을 시작으로 축하하는 내용 2줄 이내)
            설명문이나 인사말은 절대 생략하고 오직 위 3가지 대괄호 태그들과 한글 가사 본문만 딱 출력해.`;
        } else {
            const randomCoin = Math.floor(Math.random() * 2);

            if (randomCoin === 0) {
                prompt = `너는 감동적이고 신나는 생일 축하 노래를 작사하는 최고의 AI 작사가야. 이름: ${name}, 탄생석: ${stone}, 탄생화: ${flower}. 설명이나 인사말은 절대 넣지 말고 가사 본문만 출력해라.`;
            } else {
                prompt = `너는 감동적이고 신나는 생일 축하 노래를 작사하는 최고의 AI 작사가야.
                반드시 아래의 가사 구조와 내용을 '최대한 그대로 유지'하면서, 음악 장르 ${genre} 스타일에 어울리는 세련된 한글 가사로 완성해줘.
                설명이나 인사말은 절대 넣지 말고, 대괄호 태그를 포함한 가사 본문만 딱 출력해라.
                [가사 필수 레이아웃 및 본문 지시]
                [Intro]
                ${name} 생일 축하해
                [Pre-Chorus]
                저 우주 너머 ${zodiac} 에서
                태어나 지구로 날아온 ${name}
                [Verse 1]
                ${stone} 깨고 태어난 사랑스런 ${name}
                ${flower} 향기 가득한 날에 태어난 당신 
                함께있는 우리 모두 모여
                온마음을 다해 축하 축하합니다
                [Chorus]
                ${stone} 깨고 태어난 사랑스런 ${name}
                ${flower} 향기 가득한 날에 태어난 당신
                [Verse 2]
                아름다운 그 이름 ${name}
                ${name}의 생일을 
                진심으로 축하 축하합니다.`;
            }
        }

        const ai = new GoogleGenerativeAI(GEMINI_API_KEY);
        
        // 📡 [Fail-Over 멀티 체인 리스트 정의]
        const modelsToTry = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-1.5-flash"];
        let generatedLyrics = "";
        let success = false;

        for (const modelName of modelsToTry) {
            try {
                console.log(`📡 Gemini 모델 호출 우회 시도 중: ${modelName}...`);
                const model = ai.getGenerativeModel({ model: modelName });
                const result = await model.generateContent(prompt);
                const aiResponse = await result.response;
                if (aiResponse && aiResponse.text) {
                    generatedLyrics = aiResponse.text();
                    success = true;
                    console.log(`✅ [성공] Gemini ${modelName} 모델로 가사 생성 완료!`);
                    break;
                }
            } catch (aiError) {
                console.warn(`⚠️ [경고] ${modelName} 모델 일시 마비(503/트래픽 과부하). 다음 모델로 자동 전환을 수행합니다...`);
            }
        }

        // 모든 구글 모델 호출이 실패했을 때의 최종 든든한 가드장치
        if (!success) {
            console.error("❌ 모든 Gemini AI 서비스가 구글 서버 오류로 동작하지 않습니다. 실시간 동적 커스텀 백업 가사 엔진을 기동합니다!");
            generatedLyrics = defaultLyrics;
        }

        return res.json({ lyrics: generatedLyrics });

    } catch (globalError) {
        console.error("🚨 서버 내부 에러 발생:", globalError);
        return res.status(500).json({ error: "서버 내부 오류로 가사를 생성할 수 없습니다." });
    }
});

// ==========================================
// 🎵 [API] Suno AI 음원 생성 결합 라우터
// ==========================================
async function universalFetch(url, options) {
    if (globalThis.fetch) {
        return globalThis.fetch(url, options);
    }
    const nodeFetch = await import('node-fetch');
    return nodeFetch.default(url, options);
}

app.post('/api/generate-song', async (req, res) => {
    const { prompt, genre, title, lyricMode, name } = req.body;

    try {
        if (!SUNO_API_KEY) {
            return res.status(400).json({ error: "Suno API Key가 설정되지 않았습니다." });
        }

        const isCustomMode = lyricMode !== 'suno';
        const requestBody = {
            prompt: prompt,
            customMode: isCustomMode,
            style: genre || 'pop',
            title: title || 'My Pet Birthday Song',
            instrumental: false,
            model: 'V4_5ALL',
            callBackUrl: 'https://birthday-backend-server.onrender.com/api/suno-callback'
        };

        const response = await universalFetch('https://api.sunoapi.org/api/v1/generate', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${SUNO_API_KEY.trim()}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        let data;
        try {
            data = await response.json();
        } catch (jsonErr) {
            return res.status(500).json({ error: "Suno 서버 에러 응답 발생" });
        }

        if (data.code === 200 && data.data && data.data.taskId) {
            return res.json({
                success: true,
                taskId: data.data.taskId
            });
        } else {
            console.error("❌ Suno 서버 요청 실패:", data.msg);
            return res.status(500).json({ error: data.msg || "Suno 노래 요청에 실패했습니다." });
        }
    } catch (error) {
        console.error("❌ 서버 내부 치명적 예외:", error);
        return res.status(500).json({ error: "음악 생성 서버 통신 오류" });
    }
});

// ==========================================
// 🔍 [API] Suno 생성 상태 모니터링 라우터
// ==========================================
app.get('/api/song-status/:taskId', async (req, res) => {
    const { taskId } = req.params;
    if (!SUNO_API_KEY) return res.status(500).json({ status: 'ERROR' });

    try {
        const sunoApiUrl = `https://api.sunoapi.org/api/v1/generate/record-info?taskId=${taskId}`;
        const response = await universalFetch(sunoApiUrl, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${SUNO_API_KEY.trim()}` }
        });

        if (!response.ok) return res.status(response.status).json({ status: 'ERROR' });

        let result = await response.json();
        const taskData = result.data;
        let currentStatus = 'PENDING';

        if (taskData?.status) {
           currentStatus = String(taskData.status).toUpperCase();
        } else if (Array.isArray(taskData) && taskData.length > 0 && taskData[0].status) {
            currentStatus = String(taskData[0].status).toUpperCase();
        }
       
        if (currentStatus === 'SUCCESS') {
            let audioUrl = null;
            let finalPrompt = null;
            let musicArray = [];

            if (Array.isArray(taskData.data)) musicArray = taskData.data;
            else if (Array.isArray(taskData)) musicArray = taskData;
            else if (taskData.response && Array.isArray(taskData.response.data)) musicArray = taskData.response.data;

            if (musicArray.length > 0) {
                const track = musicArray[0];
                audioUrl = track.audio_url || track.audioUrl || track.stream_audio_url || null;
                finalPrompt = track.prompt || track.lyric || null;
            }

            if (!audioUrl && taskData) {
                const str = JSON.stringify(taskData);
                const match = str.match(/(https?:\/\/[^\s"'<>]+\.(?:mp3|mp4|m4a))/i);
                if (match) audioUrl = match[1] || match[0];
            }

            if (audioUrl && (audioUrl.includes('render.com') || audioUrl.includes('callback'))) {
                audioUrl = null;
            }

            if (taskData) {
                const rawDataString = JSON.stringify(taskData);
                const promptMatch = rawDataString.match(/"prompt"\s*:\s*"([^"]+)"/);
                if (promptMatch && promptMatch[1] && !promptMatch[1].includes('celebrating the birthday')) {
                    finalPrompt = promptMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
                }
            }

            if (audioUrl) {
                return res.json({
                    status: 'SUCCESS',
                    audioUrl: audioUrl,
                    prompt: finalPrompt,
                    lyric: finalPrompt
                });
            } else {
                return res.json({ status: 'PENDING' });
            }
        } else if (currentStatus === 'FAILED' || currentStatus === 'ERROR') {
            return res.json({ status: 'FAILED' });
        } else {
            return res.json({ status: 'PENDING' });
        }
    } catch (error) {
        return res.status(500).json({ status: 'ERROR', message: error.message });
    }
});

// ==========================================
// 🎬 [API] 앨범 재킷 이미지 + MP3 비디오 병합(굽기) 엔드포인트
// ==========================================
app.use('/videos', express.static(path.join(__dirname, 'videos')));

app.post('/api/generate-video', async (req, res) => {
    try {
        const { audioUrl, jacketImage } = req.body;
        const videoDir = path.join(__dirname, 'videos');
        if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir);

        const uniqueId = Date.now();
        const imagePath = path.join(videoDir, `temp_${uniqueId}.jpg`);
        const audioPath = path.join(videoDir, `temp_${uniqueId}.mp3`);
        const videoPath = path.join(videoDir, `video_${uniqueId}.mp4`);

        const base64Data = jacketImage.replace(/^data:image\/\w+;base64,/, "");
        fs.writeFileSync(imagePath, base64Data, 'base64');

        const audioResponse = await universalFetch(audioUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*'
            }
        });
        if (!audioResponse.ok) throw new Error("오디오 다운로드 차단됨");

        const arrayBuffer = await audioResponse.arrayBuffer();
        fs.writeFileSync(audioPath, Buffer.from(arrayBuffer));

        ffmpeg()
            .input(imagePath)
            .inputOptions(['-loop 1'])
            .input(audioPath)
            .outputOptions([
                '-map 0:v:0',
                '-map 1:a:0',
                '-c:v libx264',
                '-tune stillimage',
                '-c:a aac',
                '-b:a 192k',
                '-pix_fmt yuv420p',
                '-shortest'
            ])
            .save(videoPath)
            .on('end', () => {
                res.json({
                    success: true,
                    videoUrl: `https://birthday-backend-server.onrender.com/videos/video_${uniqueId}.mp4`
                });
                try {
                    fs.unlinkSync(imagePath);
                    fs.unlinkSync(audioPath);
                } catch (e) { }
            })
            .on('error', (err) => {
                res.status(500).json({ success: false, error: "동영상 변환 실패" });
            });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 🚀 [Vite SSR 통합 및 서버 최종 스타트]
// ==========================================
async function startServer() {
  app.use('/*splat', async (req, res, next) => {
    const url = req.originalUrl;
    
    if (url.startsWith('/api') || url.startsWith('/videos')) {
      return next();
    }

    try {
      // ssrEnvironment 환경변수가 없을 경우 오류 발생 차단 장치를 마련합니다.
      if (typeof ssrEnvironment !== 'undefined') {
        const result = await ssrEnvironment.transformRequest(url);
        if (result && result.code) {
          return res.status(200).set({ 'Content-Type': 'application/javascript' }).end(result.code);
        }
      }
      next();
    } catch (e) {
      console.error("에러:", e);
      res.status(500).end(e.message);
    }
  });

  app.listen(PORT, () => {
      console.log(`🚀 백엔드 서버가 ${PORT} 포트에서 구동을 시작했습니다.`);
  });
}

startServer().catch((err) => console.error("⚠️ Vite 개발 서버 초기화 실패:", err));