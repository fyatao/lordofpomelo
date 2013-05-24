/**
 * Module dependencies
 */

var area = require('../../../domain/area/area');
var messageService = require('../../../domain/messageService');
var userDao = require('../../../dao/userDao');
var logger = require('pomelo-logger').getLogger(__filename);
var pomelo = require('pomelo');
var consts = require('../../../consts/consts');
var dataApi = require('../../../util/dataApi');

var handler = module.exports;

// global team container(teamId:teamObj)
var gTeamObjDict = {};
// max member num in a team
var MAX_MEMBER_NUM = 3;
// none player id in a team(placeholder)
var PLAYER_ID_NONE = 0;
// global team id
var gTeamId = 1;
// team member title(member/captain)
var TEAM_TITLE = {
	MEMBER  : 0,
	CAPTAIN : 1,	
};
// player's replying code
var JOIN_TEAM_REPLY = {
	REJECT : 0,
	ACCEPT : 1,	
};
// return code of trying to join a team
var JOIN_TEAM_RET_CODE = {
	OK							: 0,	// join ok
	NO_POSITION			: -1,	// there is no position
	ALREADY_IN_TEAM	: -2,	// already in the team
	IN_OTHER_TEAM		: -3,	// already in other team
	SYS_ERROR				: -4,	// system error
};
///////////////////////////////////////////////////////
function Team(){
	this.teamId = 0;
	this.playerNum = 0;
	this.captainId = 0;
	this.playerIdArray = new Array(MAX_MEMBER_NUM);
	// team channel, push msg within the team
	this.channel = null;

	var _this = this; 
	// constructor
	var init = function()	{
		_this.teamId = ++gTeamId;
		for(var i in _this.playerIdArray) {
			i = PLAYER_ID_NONE;
		}
	};

	init();
}

Team.prototype.createChannel = function(playerId) {
	if(this.channel || this.getPlayerNum() <= 1) {
		return this.channel;
	}
	this.channel = pomelo.app.get('channelService').getChannel('team_' + this.teamId, true);
	if(this.channel) {
		for(var i in this.playerIdArray) {
			if(i != PLAYER_ID_NONE) {
				var player = area.getPlayer(playerId);
				if(!player) {
					continue;
				}
				this.channel.add(player.userId, player.serverId);
			}
		}
		return this.channel;
	}
	return null;
};

Team.prototype.addPlayer2Channel = function(playerId) {
	if(!this.channel) {
		return false;
	}
	var player = area.getPlayer(playerId);
	if(player) {
		this.channel.add(player.userId, player.serverId);
		return true;
	}
	return false;
};

Team.prototype.removePlayerFromChannel = function(playerId) {
	if(!this.channel) {
		return false;
	}
	var player = area.getPlayer(playerId);
	if(player) {
		this.channel.leave(player.userId, player.serverId);
		return true;
	}
	return false;
};

function doAddPlayer(teamObj, playerId) {
	for(var i in teamObj.playerIdArray)
	{
		if(i === PLAYER_ID_NONE)
		{
			i = playerId;
			return true;
		}
	}
	return false;
}

Team.prototype.addPlayer = function(playerId) {
	if(!this.isTeamHasPosition()) {
		return JOIN_TEAM_RET_CODE.NO_POSITION;
	}

	if(this.isPlayerInTeam(playerId)) {
		return JOIN_TEAM_RET_CODE.ALREADY_IN_TEAM;
	}

	var playerObj = area.getPlayer(playerId);
	if(!playerObj) {
		return JOIN_TEAM_RET_CODE.SYS_ERROR;
	}

	// if the player is already in a team, can't join other
	if(playerObj.teamId != consts.TEAM.TEAM_ID_NONE) {
		return JOIN_TEAM_RET_CODE.IN_OTHER_TEAM;
	}

	if(!doAddPlayer(this, playerId)) {
		return JOIN_TEAM_RET_CODE.SYS_ERROR;
	}

	if(!playerObj.joinTeam(this.teamId)) {
		return JOIN_TEAM_RET_CODE.SYS_ERROR;
	}

	if(!this.isPlayerInTeam(playerId)) {
		return JOIN_TEAM_RET_CODE.SYS_ERROR;
	}

	if(this.channel) {
		this.addPlayer2Channel();
	} else {
		this.createChannel();
	}

	if(this.playerNum < MAX_MEMBER_NUM) {
		this.playerNum++;
	}

	this.pushInfo2Everyone();

	return JOIN_TEAM_RET_CODE.OK;
};

// the captain_id is just a player_id
Team.prototype.setCaptainId = function(captainId) {
	this.captainId = captainId;
};

// player num in the team
Team.prototype.getPlayerNum = function() {
	return this.playerNum;
};

// is there a empty position in the team
Team.prototype.isTeamHasPosition = function() {
	return this.getPlayerNum() < MAX_MEMBER_NUM;
};

// is there any member in the team
Team.prototype.isTeamHasMember = function() {
	return this.getPlayerNum() > 0;
};

// the first real player_id in the team
Team.prototype.getFirstPlayerId = function() {
	for(var i in this.playerIdArray)
	{
		if(i != PLAYER_ID_NONE)
			return i;
	}
	return PLAYER_ID_NONE;
};

// check if a player in the team
Team.prototype.isPlayerInTeam = function(playerId) {
	for(var i in this.playerIdArray)
	{
		if(i != PLAYER_ID_NONE && i === playerId)
			return true;
	}
	return false;
};

// push the team members' info to everyone
Team.prototype.pushInfo2Everyone = function() {
	for(var i in this.playerIdArray)
	{
		if(i === PLAYER_ID_NONE)
			continue;
		var playerId = i;
		var player = area.getPlayer(playerId);

		var infoObjDict;
		for(var j in this.playerIdArray)
		{
			if(j === PLAYER_ID_NONE || j === playerId)
				continue;
			var tmpPlayer = area.getPlayer(j);
			var infoObj = tmpPlayer.toJSON4Team(this.captainId === j);
			infoObjDict = infoObjDict || {};
			infoObjDict[j] = infoObj;
		}
		if(infoObjDict)
		{
			// use channel
			messageService.pushMessageToPlayer({uid : player.userId, sid : player.serverId}, 'onUpdateTeam', infoObjDict);
		}
	}
	return true;
};

// notify the rest of team members of the left player
Team.prototype.pushLeaveMsg2Else = function(leavePlayerId) {
	if(!this.channel) {
		return false;
	}
	var msg = {
		leavePlayerId : leavePlayerId
	};
	this.channel.pushMessage('onTeammateLeaveTeam', msg, null);
	return true;
};

// disband the team
Team.prototype.disbandTeam = function() {
	// under some conditions, the team can't be disbanded
	// return false;
	this.channel.pushMessage('onDisbandTeam', {}, null);
	for(var i in this.playerIdArray)
	{
		if(i === PLAYER_ID_NONE)
			continue;
		var tmpPlayer = area.getPlayer(i);
		tmpPlayer.leaveTeam();
	}
	return true;
};

// remove a player from the team
Team.prototype.removePlayerById = function(playerId) {
	for(var i in this.playerIdArray)
	{
		if(i != PLAYER_ID_NONE && i === playerId) {
			i = PLAYER_ID_NONE;
			break;
		}
	}

	this.removePlayerFromChannel(playerId);
	
	if(this.playerNum > 0) {
		this.playerNum--;
	}

	if(this.isTeamHasMember()) {
		this.pushLeaveMsg2Else(playerId);
	}

	return true;
};

// push msg to all of the team members 
Team.prototype.pushChatMsg2All = function(content) {
	if(!this.channel) {
		return false;
	}
	var msg = {
		content : content,
	};
	this.channel.pushMessage('onChatInTeam', msg, null);
	return true;
};

///////////////////////////////////////////////////////
/**
 * Player create a team, and response the result information : success(1)/failed(0)
 *
 * @param {Object} msg
 * @param {Object} session
 * @param {Function} next
 * @api public
 */
handler.createTeam = function(msg, session, next) {
	var playerId = session.get('playerId');
	var player = area.getPlayer(playerId);

	var result = JOIN_TEAM_RET_CODE.SYS_ERROR;

	if(!player) {
    logger.warn('The request(createTeam) is illegal, the player is null : msg = %j.', msg);
  	next();
		return;
	}

	teamObj = new Team();

	result = teamObj.addPlayer(playerId);
	if(result === JOIN_TEAM_RET_CODE.OK) {
		teamObj.setCaptainId(playerId);
		gTeamObjDict[teamObj.teamId] = teamObj;
	}

  next(null, {result : result});
};

/**
 * Captain disband the team, and response the result information : success(1)/failed(0)
 *
 * @param {Object} msg
 * @param {Object} session
 * @param {Function} next
 * @api public
 */
handler.disbandTeam = function(msg, session, next) {
	var playerId = session.get('playerId');
	var player = area.getPlayer(playerId);

	var result = false;

	if(!player) {
    logger.warn('The request(disbandTeam) is illegal, the player is null : msg = %j.', msg);
  	next();
		return;
	}

  var teamObj = gTeamObjDict[msg.teamId];
	if(!teamObj) {
    logger.warn('The request(disbandTeam) is illegal, the team is null : msg = %j.', msg);
  	next(null, {result : result});
		return;
	}

	if(playerId != teamObj.captainId) {
    logger.warn('The request(disbandTeam) is illegal, the player is not the captain : msg = %j.', msg);
  	next(null, {result : result});
		return;
	}

	result = teamObj.disbandTeam();
	if(result) {
		delete gTeamObjDict[msg.teamId];
	}

  next(null, {result : result});
};

/**
 * Notify: Captain invite a player to join the team, and push invitation to the invitee
 *
 * @param {Object} msg
 * @param {Object} session
 * @param {Function} next
 * @api public
 */
handler.inviteJoinTeam = function(msg, session, next) {
	var playerId = session.get('playerId');
	var player = area.getPlayer(playerId);

	var result = false;

	if(!player) {
    logger.warn('The request(inviteJoinTeam) is illegal, the player is null : msg = %j.', msg);
  	next();
		return;
	}

	var teamObj = gTeamObjDict[player.teamId];
	if(!teamObj) {
    logger.warn('The request(inviteJoinTeam) is illegal, the team is null : msg = %j.', msg);
  	next();
		return;
	}

	if(playerId != teamObj.captainId) {
    logger.warn('The request(inviteJoinTeam) is illegal, the player is not the captain : msg = %j.', msg);
  	next();
		return;
	}

	if(!teamObj.isTeamHasPosition()) {
		next();
		return;
	}

	var invitee = area.getPlayer(msg.inviteeId);
	if(!invitee) {
    logger.warn('The request(inviteJoinTeam) is illegal, the invitee is null : msg = %j.', msg);
		next();
		return;
	}

	var infoObj = player.toJSON4Team(true);

	// send invitation to the invitee
	messageService.pushMessageToPlayer({uid : invitee.userId, sid : invitee.serverId}, 'onInviteJoinTeam', infoObj);
};

/**
 * Request: invitee reply to join the team's captain, response the result, and push msg to the team members
 *
 * @param {Object} msg
 * @param {Object} session
 * @param {Function} next
 * @api public
 */
handler.inviteJoinTeamReply = function(msg, session, next) {
	var playerId = session.get('playerId');
	var player = area.getPlayer(playerId);

	if(!player) {
    logger.warn('The request(inviteJoinTeamReply) is illegal, the player is null : msg = %j.', msg);
  	next();
		return;
	}

	var teamObj = gTeamObjDict[msg.teamId];
	if(!teamObj) {
    logger.warn('The request(inviteJoinTeamReply) is illegal, the team is null : msg = %j.', msg);
  	next();
		return;
	}

	if(msg.captainId != teamObj.captainId) {
    logger.warn('The request(inviteJoinTeamReply) is illegal, the player is not the captain : msg = %j.', msg);
  	next();
		return;
	}

	var captainObj = area.getPlayer(msg.captainId);
	if(!captainObj) {
    logger.warn('The request(inviteJoinTeamReply) is illegal, the captain is null : msg = %j.', msg);
  	next();
		return;
	}

	if(msg.reply === JOIN_TEAM_REPLY.ACCEPT) {
		var result = teamObj.addPlayer(playerId);
  	next(null, {result : result});
	} else {
		// push msg to the inviter(the captain) that the invitee reject to join the team
		var msg = {
			reply : false;
		};
		messageService.pushMessageToPlayer({uid : captainObj.userId, sid : captainObj.serverId}, 'onInviteJoinTeamReply', msg);
	}
  next();
};

/**
 * Notify: applicant apply to join the team, and push the application to the captain
 *
 * @param {Object} msg
 * @param {Object} session
 * @param {Function} next
 * @api public
 */
handler.applyJoinTeam = function(msg, session, next) {
	var playerId = session.get('playerId');
	var player = area.getPlayer(playerId);

	if(!player) {
    logger.warn('The request(applyJoinTeam) is illegal, the player is null : msg = %j.', msg);
  	next();
		return;
	}

	if(player.isInTeam()) {
  	next();
		return;
	}

	var teamObj = gTeamObjDict[msg.teamId];
	if(!teamObj) {
    logger.warn('The request(applyJoinTeam) is illegal, the team is null : msg = %j.', msg);
  	next();
		return;
	}

	if(!teamObj.isTeamHasPosition()) {
  	next();
		return;
	}

	var captainObj = area.getPlayer(teamObj.captainId);
	if(!captainObj) {
    logger.warn('The request(applyJoinTeam) is illegal, the captain is null : msg = %j.', msg);
  	next();
		return;
	}

	var infoObj = player.toJSON4Team();
	// send the application to the captain
	messageService.pushMessageToPlayer({uid : captainObj.userId, sid : captainObj.serverId}, 'onApplyJoinTeam', infoObj);
  next();
};
	
/**
 * Notify: captain replys the application, and push msg to the team members(accept) or only the applicant(reject)
 *
 * @param {Object} msg
 * @param {Object} session
 * @param {Function} next
 * @api public
 */
handler.applyJoinTeamReply = function(msg, session, next) {
	var playerId = session.get('playerId');
	var player = area.getPlayer(playerId);

	if(!player) {
    logger.warn('The request(applyJoinTeamReply) is illegal, the player is null : msg = %j.', msg);
  	next();
		return;
	}

	var teamObj = gTeamObjDict[msg.teamId];
	if(!teamObj) {
    logger.warn('The request(applyJoinTeamReply) is illegal, the team is null : msg = %j.', msg);
  	next();
		return;
	}

	if(playerId != teamObj.captainId) {
    logger.warn('The request(applyJoinTeamReply) is illegal, the player is not the captain : msg = %j.', msg);
  	next();
		return;
	}

	var applicant = area.getPlayer(msg.applicantId);
	if(!applicant) {
    logger.warn('The request(applyJoinTeamReply) is illegal, the applicant is null : msg = %j.', msg);
  	next();
		return;
	}

	if(applicant.isInTeam()) {
  	next();
		return;
	}

	if(msg.reply === JOIN_TEAM_REPLY.ACCEPT) {
		var result = teamObj.addPlayer(msg.applicantId);
  	next(null, {result : result});
	}
	else {
		// push msg to the applicant that the capatain rejected
		var msg = {
			reply : false
		};
		messageService.pushMessageToPlayer({uid : applicant.userId, sid : applicant.serverId}, 'onApplyJoinTeamReply', msg);
	}
  next();
};

// check member num when a member leaves the team,
// if there is no member in the team,
// disband the team automatically
function try2DisbandTeam(teamObj) {
	if(!teamObj.isTeamHasMember()) {
		delete gTeamObjDict[teamObj.teamId];
	}
}

/**
 * Captain kicks a team member, and push info to the kicked member and other members
 *
 * @param {Object} msg
 * @param {Object} session
 * @param {Function} next
 * @api public
 */
handler.kickOutOfTeam = function(msg, session, next) {
	var playerId = session.get('playerId');
	var player = area.getPlayer(playerId);

	if(!player) {
    logger.warn('The request(kickOutOfTeam) is illegal, the player is null : msg = %j.', msg);
  	next();
		return;
	}

	if(playerId === msg.kickedPlayerId) {
  	next();
		return;
	}

  var teamObj = gTeamObjDict[msg.teamId];
	if(!teamObj) {
    logger.warn('The request(kickOutOfTeam) is illegal, the team is null : msg = %j.', msg);
  	next();
		return;
	}

	if(playerId != teamObj.captainId) {
    logger.warn('The request(kickOutOfTeam) is illegal, the player is not the captain : msg = %j.', msg);
  	next();
		return;
	}

	var kickedPlayer = area.getPlayer(msg.kickedPlayerId);
	if(!kickedPlayer) {
    logger.warn('The request(kickOutOfTeam) is illegal, the kicked player is null : msg = %j.', msg);
  	next();
		return;
	}

	if(!teamObj.isPlayerInTeam(msg.kickedPlayerId)) {
  	next();
		return;
	}

	kickedPlayer.leaveTeam(true);

	teamObj.removePlayerById(msg.kickedPlayerId);
	try2DisbandTeam(teamObj);

  next();
};

/**
 * member leave the team voluntarily, and push info to other members
 *
 * @param {Object} msg
 * @param {Object} session
 * @param {Function} next
 * @api public
 */
handler.leaveTeam = function(msg, session, next) {
	var playerId = session.get('playerId');
	var player = area.getPlayer(playerId);

	if(!player) {
    logger.warn('The request(leaveTeam) is illegal, the player is null : msg = %j.', msg);
  	next();
		return;
	}

  var teamObj = gTeamObjDict[msg.teamId];
	if(!teamObj) {
    logger.warn('The request(leaveTeam) is illegal, the team is null : msg = %j.', msg);
  	next();
		return;
	}

	if(!teamObj.isPlayerInTeam(msg.kickedPlayerId)) {
  	next();
		return;
	}

	player.leaveTeam(true, true);

	teamObj.removePlayerById(playerId);

	// if the captain leaves the team,
	// depute the captain to the next member
	if(playerId === teamObj.captainId) {
		var firstPlayerId = teamObj.getFirstPlayerId();
		if(firstPlayerId != PLAYER_ID_NONE) {
			teamObj.setCaptainId(firstPlayerId);
		}
	}

	try2DisbandTeam(teamObj);

  next();
};

/**
 * Captain deputes to a member, and push info to all 
 *
 * @param {Object} msg
 * @param {Object} session
 * @param {Function} next
 * @api public
 */
handler.depute2Member = function(msg, session, next) {
	var playerId = session.get('playerId');
	var player = area.getPlayer(playerId);

	if(!player) {
    logger.warn('The request(depute2Member) is illegal, the player is null : msg = %j.', msg);
  	next();
		return;
	}

  var teamObj = gTeamObjDict[msg.teamId];
	if(!teamObj) {
    logger.warn('The request(depute2Member) is illegal, the team is null : msg = %j.', msg);
  	next();
		return;
	}

	if(playerId != teamObj.captainId) {
    logger.warn('The request(depute2Member) is illegal, the player is not the captain : msg = %j.', msg);
  	next();
		return;
	}

	if(!teamObj.isPlayerInTeam(msg.memberId)) {
  	next();
		return;
	}

	teamObj.setCaptainId(msg.memberId);

  next();
};

/**
 * members chat in the team, and push content to other members
 *
 * @param {Object} msg
 * @param {Object} session
 * @param {Function} next
 * @api public
 */
handler.chatInTeam = function(msg, session, next) {
	var playerId = session.get('playerId');
	var player = area.getPlayer(playerId);

	if(!player) {
    logger.warn('The request(chatInTeam) is illegal, the player is null : msg = %j.', msg);
  	next();
		return;
	}

  var teamObj = gTeamObjDict[msg.teamId];
	if(!teamObj) {
    logger.warn('The request(chatInTeam) is illegal, the team is null : msg = %j.', msg);
  	next();
		return;
	}

	if(!teamObj.isPlayerInTeam(playerId)) {
    logger.warn('The request(chatInTeam) is illegal, the player is not int team : msg = %j.', msg);
  	next();
		return;
	}

	teamObj.pushChatMsg2All(msg.content);

  next();
};
