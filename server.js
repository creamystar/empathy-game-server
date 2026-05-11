const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// 방 목록 저장
const rooms = {};

// 1시간마다 비활성 방 자동 청소
const ONE_HOUR = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  let deleted = 0;
  Object.keys(rooms).forEach(code => {
    const room = rooms[code];
    if (now - room.lastActivity > ONE_HOUR) {
      io.to(code).emit('roomClosed', { message: '1시간 동안 활동이 없어 방이 닫혔습니다.' });
      io.socketsLeave(code);
      delete rooms[code];
      deleted++;
    }
  });
  if (deleted > 0) console.log(`[청소] ${deleted}개 방 삭제됨. 현재 방 수: ${Object.keys(rooms).length}`);
}, ONE_HOUR);

// 랜덤 주제 목록
const randomTopics = [
  '여름휴가', '좋아하는음식', '스트레스해소법', '주말에하는것', '버킷리스트',
  '무인도에가져갈것', '행복한순간', '두려운것', '갖고싶은능력', '존경하는사람',
  '가고싶은나라', '좋아하는계절', '어릴때꿈', '최근본영화', '좋아하는운동',
  '아침에일어나면', '자기전에하는것', '친구에게선물한다면', '나를표현하는단어', '10년후내모습',
  '여행', '시간', '노랑', '빨강', '파랑', '보라', '사랑', '행복', '친구', '봄', '여름', '가을', '겨울'
];

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function calculateScore(selectedWord, allPlayers, currentPlayerId) {
  // 이 단어를 가진 플레이어 수 세기
  let count = 0;
  const totalPlayers = allPlayers.length;

  allPlayers.forEach(player => {
    if (player.words && player.words.includes(selectedWord)) {
      count++;
    }
  });

  // 점수 계산
  if (count === 0) return 0; // 아무도 없음
  if (count === 1) return 0; // 본인만 있음
  if (count === 2) return 4; // 나 포함 2명 (전원 여부 상관없이 4점)
  if (count === totalPlayers) return 0; // 3명 이상일 때 전원이면 0점
  return count; // 3명이상은 인원수만큼 점수
}

io.on('connection', (socket) => {
  console.log('접속:', socket.id);

  // 방 만들기
  socket.on('createRoom', ({ nickname, title, password }) => {
    let roomCode = generateRoomCode();
    while (rooms[roomCode]) roomCode = generateRoomCode();

    rooms[roomCode] = {
      code: roomCode,
      title: title || '공감 게임',
      password: password || '',
      host: socket.id,
      lastActivity: Date.now(),
      players: [{
        id: socket.id,
        nickname,
        ready: false,
        score: 0,
        words: [],
        usedWords: [],
        joinOrder: 0
      }],
      status: 'waiting', // waiting, playing
      gamePhase: 'topic', // topic, writing, selecting, result
      topic: '',
      currentPlayerIndex: 0,
      turnCount: 0,
      roundScores: {},
      lastLastPlace: null,
    };

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.nickname = nickname;

    socket.emit('roomCreated', { roomCode, room: sanitizeRoom(rooms[roomCode]), isHost: true });
  });

  // 방 입장
  socket.on('joinRoom', ({ nickname, roomCode, password }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit('joinError', '존재하지 않는 방입니다.');
    if (room.status !== 'waiting') return socket.emit('joinError', '이미 게임이 시작된 방입니다.');
    if (room.players.length >= 30) return socket.emit('joinError', '방이 가득 찼습니다.');
    if (room.password && room.password !== password) return socket.emit('joinError', '비밀번호가 틀렸습니다.');
    if (room.players.find(p => p.nickname === nickname)) return socket.emit('joinError', '이미 사용 중인 닉네임입니다.');

    room.players.push({
      id: socket.id,
      nickname,
      ready: false,
      score: 0,
      words: [],
      usedWords: [],
      joinOrder: room.players.length
    });
    room.lastActivity = Date.now();

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.nickname = nickname;

    socket.emit('joinSuccess', { room: sanitizeRoom(room), isHost: false });
    socket.to(roomCode).emit('playerJoined', { room: sanitizeRoom(room) });
  });

  // 준비 완료 토글
  socket.on('toggleReady', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    if (socket.id === room.host) return; // 방장은 준비 없음

    player.ready = !player.ready;
    io.to(socket.roomCode).emit('roomUpdated', { room: sanitizeRoom(room) });
  });

  // 게임 시작
  socket.on('startGame', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    if (socket.id !== room.host) return;

    const nonHostPlayers = room.players.filter(p => p.id !== room.host);
    const allReady = nonHostPlayers.every(p => p.ready);
    if (!allReady && nonHostPlayers.length > 0) return socket.emit('startError', '모든 플레이어가 준비 완료해야 합니다.');
    if (room.players.length < 2) return socket.emit('startError', '최소 2명이 필요합니다.');

    room.status = 'playing';
    room.gamePhase = 'topic';
    room.lastActivity = Date.now();

    // 순서 설정: 첫 라운드는 입장 순서
    room.players.sort((a, b) => a.joinOrder - b.joinOrder);
    room.currentPlayerIndex = 0;
    room.turnCount = 0;
    room.roundScores = {};
    room.players.forEach(p => {
      p.score = 0;
      p.words = [];
      p.usedWords = [];
      room.roundScores[p.id] = 0;
    });

    io.to(socket.roomCode).emit('gameStarted', { room: sanitizeRoom(room) });
  });

  // 주제 설정
  socket.on('setTopic', ({ topic }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    if (socket.id !== room.host) return;

    const cleanTopic = topic.replace(/[^가-힣a-zA-Z0-9]/g, '').slice(0, 20);
    if (!cleanTopic) return;

    room.topic = cleanTopic;
    room.gamePhase = 'writing';

    io.to(socket.roomCode).emit('topicSet', { topic: cleanTopic });
  });

  // 랜덤 주제
  socket.on('randomTopic', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    if (socket.id !== room.host) return;

    const topic = randomTopics[Math.floor(Math.random() * randomTopics.length)];
    room.topic = topic;
    room.gamePhase = 'writing';

    io.to(socket.roomCode).emit('topicSet', { topic });
  });

  // 단어 제출
  socket.on('submitWords', ({ words }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    // 한글/영어/숫자만 허용, 각 단어 최대 10글자
    const cleanWords = words
      .map(w => w.replace(/[^가-힣a-zA-Z0-9]/g, '').slice(0, 10))
      .filter(w => w.length > 0)
      .slice(0, 10);

    if (cleanWords.length !== 10) return socket.emit('wordsError', '단어를 10개 모두 입력해주세요.');

    // 중복 단어 체크
    const uniqueWords = new Set(cleanWords);
    if (uniqueWords.size !== 10) return socket.emit('wordsError', '중복된 단어가 있어요. 10개 모두 다르게 입력해주세요.');

    player.words = cleanWords;
    player.wordsSubmitted = true;

    // 모든 플레이어가 제출했는지 확인
    const allSubmitted = room.players.every(p => p.wordsSubmitted);
    if (allSubmitted) {
      room.gamePhase = 'selecting';
      room.currentPlayerIndex = 0;
      room.turnCount = 0;
      io.to(socket.roomCode).emit('selectionPhaseStart', {
        room: sanitizeRoom(room),
        currentPlayerId: room.players[0].id
      });
    } else {
      io.to(socket.roomCode).emit('wordSubmitted', {
        submittedCount: room.players.filter(p => p.wordsSubmitted).length,
        totalCount: room.players.length
      });
    }
  });

  // 단어 선택
  socket.on('selectWord', ({ word }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;

    const currentPlayer = room.players[room.currentPlayerIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;
    if (currentPlayer.usedWords.includes(word)) return socket.emit('selectError', '이미 선택한 단어입니다.');
    if (!currentPlayer.words.includes(word)) return socket.emit('selectError', '본인의 단어가 아닙니다.');

    currentPlayer.usedWords.push(word);
    room.lastActivity = Date.now();

    // 점수 계산
    const score = calculateScore(word, room.players, socket.id);
    room.roundScores[socket.id] = (room.roundScores[socket.id] || 0) + score;

    // 이 단어를 가진 플레이어들 찾기
    const matchPlayers = room.players
      .filter(p => p.words.includes(word))
      .map(p => p.nickname);

    io.to(socket.roomCode).emit('wordSelected', {
      playerId: socket.id,
      playerNickname: currentPlayer.nickname,
      word,
      score,
      matchPlayers,
      roundScores: room.roundScores
    });

    // 다음 차례로
    room.turnCount++;
    const totalTurns = room.players.length * 2;

    if (room.turnCount >= totalTurns) {
      // 라운드 종료
      endRound(room, socket.roomCode);
    } else {
      room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
      const nextPlayer = room.players[room.currentPlayerIndex];
      io.to(socket.roomCode).emit('nextTurn', {
        currentPlayerId: nextPlayer.id,
        turnCount: room.turnCount,
        totalTurns
      });
    }
  });

  // 다음 라운드
  socket.on('nextRound', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    if (socket.id !== room.host) return;

    startNextRound(room, socket.roomCode);
  });

  // 연결 끊김
  socket.on('disconnect', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      delete rooms[socket.roomCode];
      return;
    }

    // 방장이 나갔으면 다음 사람이 방장
    if (room.host === socket.id) {
      room.host = room.players[0].id;
    }

    io.to(socket.roomCode).emit('playerLeft', {
      room: sanitizeRoom(room),
      leftNickname: socket.nickname
    });
  });
});

function endRound(room, roomCode) {
  // 총점 계산
  room.players.forEach(p => {
    p.score += (room.roundScores[p.id] || 0);
  });

  const scores = room.players.map(p => ({ id: p.id, nickname: p.nickname, roundScore: room.roundScores[p.id] || 0, totalScore: p.score }));
  scores.sort((a, b) => b.roundScore - a.roundScore);

  const topScore = scores[0].roundScore;
  const bottomScore = scores[scores.length - 1].roundScore;

  const winners = scores.filter(s => s.roundScore === topScore);
  const losers = scores.filter(s => s.roundScore === bottomScore);

  // 꼴찌 저장 (다음 라운드 순서용)
  room.lastLastPlace = losers.map(l => l.id);

  room.gamePhase = 'result';

  io.to(roomCode).emit('roundEnd', {
    scores,
    winners,
    losers,
    roundScores: room.roundScores
  });
}

function startNextRound(room, roomCode) {
  // 다음 라운드 순서: 꼴찌가 1등, 나머지는 입장 순서
  const lastPlaceIds = room.lastLastPlace || [];

  room.players.forEach(p => {
    p.words = [];
    p.usedWords = [];
    p.wordsSubmitted = false;
  });

  // 순서 재정렬
  if (lastPlaceIds.length > 0) {
    const lastPlacePlayers = room.players.filter(p => lastPlaceIds.includes(p.id));
    const otherPlayers = room.players
      .filter(p => !lastPlaceIds.includes(p.id))
      .sort((a, b) => a.joinOrder - b.joinOrder);
    room.players = [...lastPlacePlayers, ...otherPlayers];
  }

  room.currentPlayerIndex = 0;
  room.turnCount = 0;
  room.roundScores = {};
  room.players.forEach(p => room.roundScores[p.id] = 0);
  room.gamePhase = 'topic';
  room.topic = '';

  io.to(roomCode).emit('nextRoundStarted', { room: sanitizeRoom(room) });
}

function sanitizeRoom(room) {
  return {
    code: room.code,
    title: room.title,
    hasPassword: !!room.password,
    host: room.host,
    players: room.players.map(p => ({
      id: p.id,
      nickname: p.nickname,
      ready: p.ready,
      score: p.score,
      wordsSubmitted: p.wordsSubmitted || false,
      joinOrder: p.joinOrder
    })),
    status: room.status,
    gamePhase: room.gamePhase,
    topic: room.topic,
    currentPlayerIndex: room.currentPlayerIndex,
    turnCount: room.turnCount,
    roundScores: room.roundScores
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
