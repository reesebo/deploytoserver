'use babel';

import DeploytoserverView from './deploytoserver-view';
import { CompositeDisposable } from 'atom';
var SubAtom = require('sub-atom');
var fs = require("fs");
var Client = require('ssh2-sftp-client');
var path = require('path');
var MessagePanelView = require('atom-message-panel').MessagePanelView;
var PlainMessageView = require('atom-message-panel').PlainMessageView;
const EventEmitter = require('events');
const util = require('util');
const max_filesize =4*1024*1024*1024;
const crypto = require('crypto');
const SshClient = require('ssh2').Client;
const SSH2Shell = require ('ssh2shell');
function WorkerEmitter(){
	EventEmitter.call(this);
}
util.inherits(WorkerEmitter,EventEmitter);

export default {

  deploytoserverView: null,
  modalPanel: null,
  subscriptions: null,

  activate(state) {
    this.workerEmitter = new WorkerEmitter();
    this.initEventHandlers();
		this.initMessageView();
    this.touchedFiles = [];
    this.subs = new SubAtom;
    this.subs.add(atom.commands.add('atom-workspace',{
      'deploytoserver:deploy':(function(_this){
        return function(){
          return _this.deploy('run');
        }
      })(this),
			'deploytoserver:uploadfolder':(function(_this){
        return function(){
					var atom_obj = this;
					return _this.uploadfolderToServer(atom_obj);
        }
      })(this),
      'deploytoserver:get':(function(_this){
        return function(){
          return _this.get('run');
        }
      })(this),
			'deploytoserver:cleansvr':(function(_this){
        return function(){
          return _this.cleansvr('run');
        }
      })(this),
			'deploytoserver:inspackages':(function(_this){
        return function(){
          return _this.inspackages('run');
        }
      })(this),
			'deploytoserver:insonepackage':(function(_this){
        return function(){
          return _this.insonepackage('run');
        }
      })(this),
			'deploytoserver:generaterouter':(function(_this){
        return function(){
          return _this.generaterouter('run');
        }
      })(this),
			'deploytoserver:registerglobalmodel':(function(_this){
        return function(){
          return _this.registerglobalmodel('run');
        }
      })(this),
			'deploytoserver:deployopened':(function(_this){
        return function(){
          return _this.deployopened('run');
        }
      })(this),
			//deploytoserver:generaterouter
			//

    }));
  },
	printMessage(msg,place,type){
		//type = ['info','warning'],place = ['pop','panel']
		if(place === 'panel'){
			this.message.add(new PlainMessageView({
				message:msg,
				className:'text-' + type
			}));
		}

	},

	resolveTreeSelection() {
  	var serialView, treeView;
	  if (atom.packages.isPackageLoaded("tree-view")) {
	    treeView = atom.packages.getLoadedPackage("tree-view");
	    treeView = require(treeView.mainModulePath);
	    serialView = treeView.serialize();
	    return serialView.selectedPath;
	  }
	},

	joinPath(left,right){
		if(left.charAt(left.length - 1) === "/"){
			if(right.charAt(0) === "/"){
				return left + right.substring(1);
			}
			else{
				return left + right;
			}

		}
		else {
			if(right.charAt(0) === "/"){
				return left + right;
			}
			else{
				return left + "/" + right;
			}
		}
	},
	initMessageView(){
		this.message = new MessagePanelView({
  		title: 'Server Deployment Messages',
			recentMessagesAtTop:true
		});
		this.message.attach();
	},
	initEventHandlers(){
    this.workerEmitter.on('getAllFiles',(unhandledFoldersQty,sftp,data,index,cb)=>{
			if(index>=data.length){
					cb(data);
					return;
			}
      var curfile = data[index];
      if(curfile.type === "d"){
				unhandledFoldersQty++;
				var ppath = curfile.name;
        sftp.list(ppath).then((sub_data)=>{
					for(var i = 0 ; i<sub_data.length;i++){
						var curfile = sub_data[i];
						curfile.name = this.joinPath(ppath, curfile.name);
						data.push(curfile);
					}
					unhandledFoldersQty--;
					this.workerEmitter.emit('getAllFiles',unhandledFoldersQty,sftp,data,index + 1,cb);
        });
      }
			if(unhandledFoldersQty == 0){
	        this.workerEmitter.emit('getAllFiles',unhandledFoldersQty,sftp,data,index + 1,cb);
			}

    });

		this.workerEmitter.on('downloadFiles',(sftp,filesToDownload,index,download_overwrite,cbRunning,cbFinished)=>{
				if(index >= filesToDownload.length){
					cbFinished(true,"");
				}
				else{
					var curfile = filesToDownload[index];
					var localFileInfo = this.checkDir(curfile,download_overwrite);
					sftp.get(curfile).then((data)=>{
						cbRunning('Downloading ' + curfile + "...");
						data.on('data', (chunk) => {
							fs.appendFileSync(localFileInfo.path,chunk);
						});
						data.on('end', () => {
							cbRunning(curfile + " downloaded.");
							this.mergeSameFile(localFileInfo);
							this.workerEmitter.emit('downloadFiles',sftp,filesToDownload,index + 1,download_overwrite,cbRunning,cbFinished);
						});
					});
				}
		});

		this.workerEmitter.on('mkdirOnServer',(sftp,localfiles,deploypath,index,cbRunning,cbFinished)=>{
			if(index >= localfiles.length){
				cbFinished("");
				return;
			}
			var curfile = localfiles[index];
			var serverModePath = curfile.replace(/\\/g,'/');
			var startPos = serverModePath.indexOf(deploypath);
			if(startPos >= 0){
				var actualServerPath = serverModePath.substring(startPos);
				var lastPos = actualServerPath.lastIndexOf('/');
				if(lastPos >= 0){
					var actualServerFolderPath = actualServerPath.substring(0,lastPos);
					sftp.mkdir(actualServerFolderPath,true).then(()=>{
						cbRunning("Server path:"+actualServerFolderPath+" was created.");
						this.workerEmitter.emit('mkdirOnServer',sftp,localfiles,deploypath,index + 1,cbRunning,cbFinished);
					});
				}

			}
			else{
				this.workerEmitter.emit('mkdirOnServer',sftp,localfiles,deploypath,index + 1,cbRunning,cbFinished);
			}

		});

		this.workerEmitter.on('uploadFilesToServer',(sftp,localfiles,deploypath,index,cbRunning,cbFinished)=>{
			if(index >= localfiles.length){
				cbFinished("");
				return;
			}
			var curfile = localfiles[index];
			var serverModePath = curfile.replace(/\\/g,'/');
			var startPos = serverModePath.indexOf(deploypath);
			if(startPos >= 0){
				var actualServerPath = serverModePath.substring(startPos);
				sftp.put(curfile,actualServerPath).then(()=>{
					cbRunning("File " + curfile +" was uploaded to " + actualServerPath + ".");
					this.workerEmitter.emit('uploadFilesToServer',sftp,localfiles,deploypath,index + 1,cbRunning,cbFinished);
				});

			}
			else{
				cbRunning("File " + curfile +" was ignored.");
				this.workerEmitter.emit('uploadFilesToServer',sftp,localfiles,deploypath,index + 1,cbRunning,cbFinished);
			}
		});

		this.workerEmitter.on('cleanFiles',(sftp,filesToClean,index,cbRunning,cbFinished)=>{
				if(index >= filesToClean.length){
					cbFinished(true,"");
				}
				else{
					var curfile = filesToClean[index];
					sftp.delete(curfile).then(()=>{
						cbRunning('Deleting ' + curfile + "...");
						this.workerEmitter.emit('cleanFiles',sftp,filesToClean,index + 1,cbRunning,cbFinished);
					});
				}
		});

  },
	mergeSameFile(fileInfo){
		if(!fileInfo.hasBak)
		{
			return;
		}
		var file_data = fs.readFileSync(fileInfo.path);
		var hash = crypto.createHash('md5').update(file_data).digest('hex');
		if(hash === fileInfo.hash)
		{
			fs.unlinkSync(fileInfo.bak);
			this.printMessage("File " + fileInfo.bak +" was merged to " + fileInfo.path,"panel","info");
		}
		else{
			this.printMessage("File " + fileInfo.bak +" was reserved,bacause md5 hash was different from " + fileInfo.path,"panel","info");
		}
	},
	checkDir(dir,download_overwrite){
		var localFileInfo = {hasBak:false};
		var splited = dir.split('/');
		var localDir = this.rootDirPath;
		for(var i=0;i<splited.length - 1;i++){
			localDir += splited[i];
			if(!fs.existsSync(localDir)){
				fs.mkdirSync(localDir);
			}
			localDir += "\\";
		}
		localDir += splited[splited.length - 1];
		if(fs.existsSync(localDir)){
			var fileStat = fs.lstatSync(localDir);
			if(fileStat.size <= max_filesize){
				if(!download_overwrite){
					var dt = new Date();
					var timestamp = Date.parse(dt);
					localFileInfo.hasBak = true;
					localFileInfo.bak = localDir + "." + timestamp + ".bak";
					fs.renameSync(localDir,localFileInfo.bak);
					var file_data = fs.readFileSync(localFileInfo.bak);
					localFileInfo.hash = crypto.createHash('md5').update(file_data).digest('hex');
				}
				else{
					fs.unlinkSync(localDir);
				}
			}
			else{
				fs.unlinkSync(localDir);
			}


		}
		localFileInfo.path = localDir;
		return localFileInfo;
	},
  opencfg(callback){
    var cfg_filename = "server.json";
		var projectDirs = atom.project.getDirectories();
		if(projectDirs == 0){
			callback(null,false,"Sorry,you have no project folder opened.");
			return;
		}
    this.rootDirPath = projectDirs[0].getPath();
    var cfg_filepath = this.joinPath(this.rootDirPath,cfg_filename);
    if(fs.existsSync(cfg_filepath)){
      var json = fs.readFileSync(cfg_filepath);
      var parsed = JSON.parse(json);
      callback(parsed,true,"");
    }
    else{
      callback(null,false,"Configuration file 'server.json' not found in your project directory.");
    }

  },


  connectServer(cfg,callback){
    var sftp = new Client();
    sftp.connect({
      host:cfg.host,
      port:cfg.port,
      username:cfg.username,
      password:cfg.password
    }).then(()=>{
      callback(sftp,true,null);
    }).catch((err)=>{
      callback(sftp,false,err);
    });
  },

	isSelectedFile(filename,filter){
		if(typeof filter == "undefined"){
			return true;
		}
		else{
			var allowed = false;
			for(var i = 0;i<filter.length;i++){
				var reg = new RegExp(filter[i]+"$");
				if(reg.test(filename)){
						allowed = true;
				}
			}
			return allowed;

		}
	},

  disconnectServer(){
    this.sftp.end().then(()=>{
			this.printMessage('Disconnected from server.','panel','info');
		});
  },

	getOpenedFiles(path,cfg){
		var textEditors = atom.workspace.getTextEditors();
		if(textEditors){
			textEditors.forEach((e)=>{

				var path = e.getPath();
				if(path){
					this.localFiles.push(path);
				}
			});
		}

	},

	getLocalFiles(path,cfg){
		var subs = fs.readdirSync(path);
		for(var item in subs){
			var nextPath = path + "\\" + subs[item];
			if(fs.lstatSync(nextPath).isDirectory()){
				this.getLocalFiles(nextPath,cfg);
			}
			else{
				if(this.isSelectedFile(nextPath,cfg.filefilter)){
					this.localFiles.push(nextPath);
				}
			}
		}
	},

	deployopened(action){
		this.opencfg((cfg,cfg_status,msg)=>{
			if(cfg_status){
				this.localFiles = [];
				this.totalUploadedQty = 0;
				this.getOpenedFiles(this.rootDirPath,cfg);
				this.connectServer(cfg,(sftp,conn_status,msg)=>{
          if(conn_status){
						this.sftp = sftp;
						this.printMessage("Configure ok!Trying connect to [" + cfg.host + "] from port [" + cfg.port + "]...",'panel','info');
						this.workerEmitter.emit('mkdirOnServer',sftp,this.localFiles,cfg.deploypath,0,(msg_running)=>{
							this.printMessage(msg_running,'panel','info');
						},(msg_finished)=>{
							this.printMessage("All folders have been pre-checked for upload.",'panel','info');
							this.workerEmitter.emit('uploadFilesToServer',sftp,this.localFiles,cfg.deploypath,0,(msg_running)=>{
								this.totalUploadedQty += 1;
								this.printMessage(msg_running,'panel','info');
							},(msg_finished)=>{
								this.printMessage('All files have been uploaded:Total ' + this.totalUploadedQty + ' files. ','panel','info');
								this.disconnectServer();
							});
						});
					}
					else{
						this.printMessage("Error happend while connecting to : [" + cfg.host + "]:" + msg,'panel','warning');
					}
				});

			}
			else{
				this.printMessage("Error happend while config:" + msg,'panel','warning');
			}

		});
	},

  deploy(action){
		this.opencfg((cfg,cfg_status,msg)=>{
			if(cfg_status){
				this.localFiles = [];
				this.totalUploadedQty = 0;
				this.getLocalFiles(this.rootDirPath,cfg);
				this.connectServer(cfg,(sftp,conn_status,msg)=>{
          if(conn_status){
						this.sftp = sftp;
						this.printMessage("Configure ok!Trying connect to [" + cfg.host + "] from port [" + cfg.port + "]...",'panel','info');
						this.workerEmitter.emit('mkdirOnServer',sftp,this.localFiles,cfg.deploypath,0,(msg_running)=>{
							this.printMessage(msg_running,'panel','info');
						},(msg_finished)=>{
							this.printMessage("All folders have been pre-checked for upload.",'panel','info');
							this.workerEmitter.emit('uploadFilesToServer',sftp,this.localFiles,cfg.deploypath,0,(msg_running)=>{
								this.totalUploadedQty += 1;
								this.printMessage(msg_running,'panel','info');
							},(msg_finished)=>{
								this.printMessage('All files have been uploaded:Total ' + this.totalUploadedQty + ' files. ','panel','info');
								this.disconnectServer();
							});
						});
					}
					else{
						this.printMessage("Error happend while connecting to : [" + cfg.host + "]:" + msg,'panel','warning');
					}
				});

			}
			else{
				this.printMessage("Error happend while config:" + msg,'panel','warning');
			}

		});
    //atom.notifications.addInfo("Test from deploy!" + this.rootDirPath, {dismissable:true});
  },
	inspackages(action){
		this.opencfg((cfg,cfg_status,msg)=>{
			if(cfg_status){
				var node_module_dir = this.joinPath(cfg.deploypath,"node_modules");
				var local_deploy_path = cfg.deploypath.replace(/\//g,'\\');
				local_deploy_path = this.joinPath(this.rootDirPath,local_deploy_path);
				var local_package_path = this.joinPath(local_deploy_path,"package.json");
				if(!fs.existsSync(local_package_path)){
					this.printMessage('Cannot install npm packages,package.json not found.');
					return;
				}
				var packageData = fs.readFileSync(local_package_path);
				var packageJSON = JSON.parse(packageData);
				var dependencies = packageJSON.dependencies;
				var _this = this;

				var host = {
					server:{
						host:cfg.host,
						userName:cfg.username,
						password:cfg.password
					},
					textColorFilter:    "([[0-9;]+[Gm])",
	  			asciiFilter:        "[^\r\n\x20-\x7e]",
	  			diableColorFilter:  false,
					idleTimeOut:        30000,
					commands:[
						"cd " + cfg.deploypath,
					],
					onCommandComplete:function(command,response,sshObj){
						_this.printMessage('Running command:' + command,'panel','info');
						var splited = response.split('\r\n');
						for(var i = splited.length - 1;i>=0;i--){
							_this.printMessage(splited[i],'panel','info');
						}

					},
					msg:{
						send:function(message){
							_this.printMessage("ssh:"+message,'panel','info');
						}
					}
				};

				//var packagesToInstall = [];
				for(var key in dependencies){
					host.commands.push('cnpm install ' + key +' --save');
				}
				var ssh = new SSH2Shell(host);
				ssh.connect();
			}
			else{
				this.printMessage("Error happend while config:" + msg,'panel','warning');
			}

		});
	},
	insonepackage(action){
		this.opencfg((cfg,cfg_status,msg)=>{
			var _this = this;
			if(cfg_status){
				var node_module_dir = this.joinPath(cfg.deploypath,"node_modules");
				var editor = atom.workspace.getActiveTextEditor();
				var selection = editor.getLastSelection();
				if(selection.isEmpty()){
					this.printMessage('To install node package,select text as a package name first.','panel','info');
				}
				else{
					if(selection.getBufferRange().isSingleLine()){
						var selectedText = selection.getText();
						var host = {
							server:{
								host:cfg.host,
								userName:cfg.username,
								password:cfg.password
							},
							textColorFilter:    "([[0-9;]+[Gm])",
			  			asciiFilter:        "[^\r\n\x20-\x7e]",
			  			diableColorFilter:  false,
							idleTimeOut:        30000,
							commands:[
								"cd " + cfg.deploypath,
								"cnpm install " + selectedText
							],
							onCommandComplete:function(command,response,sshObj){
								_this.printMessage('Running command:' + command,'panel','info');
								var splited = response.split('\r\n');
								for(var i = splited.length - 1;i>=0;i--){
									_this.printMessage(splited[i],'panel','info');
								}

							},
							msg:{
								send:function(message){
									_this.printMessage("ssh:"+message,'panel','info');
								}
							}
						};
						var ssh = new SSH2Shell(host);
						ssh.connect();
					}
					else{
						_this.printMessage('To install node package,select text as a package name first.')
					}

				}


			}
			else{
				_this.printMessage('Sorry!We can not handle multi-line selection.','panel','info');
			}

		});
	},

	findRouter(path,router_base_dir){
		var subs = fs.readdirSync(path);
		for(var item in subs){
			var nextPath = path + "\\" + subs[item];
			if(fs.lstatSync(nextPath).isDirectory()){
				if(!router_base_dir)
					router_base_dir = subs[item];
				if(path.indexOf(router_base_dir)<0)
					router_base_dir = subs[item];
				this.findRouter(nextPath,router_base_dir);
			}
			else{
				if(this.isSelectedFile(nextPath,['.js'])){
					var fileContent = fs.readFileSync(nextPath);
					if(fileContent.indexOf("global.web.initRouter(") >= 0){
						if(!(router_base_dir in this.routerFiles)){
							this.routerFiles[router_base_dir] = [];
						}
						this.routerFiles[router_base_dir].push(nextPath);
					}
				}
			}
		}
	},

	generaterouter(action){
		this.opencfg((cfg,cfg_status,msg)=>{
			this.routerFiles = {};
			var _this = this;
			if(cfg_status){
				if("webpath" in cfg){
					var webpath = _this.joinPath(_this.rootDirPath,cfg.webpath);
					this.findRouter(webpath,null);
					var allRouters = {};
					for(var router_key in this.routerFiles){
						allRouters[router_key] = {};
						this.routerFiles[router_key].forEach((e)=>{
							var serverPath = e.replace(this.rootDirPath,"").replace(/\\/g,'/');
							var routerRelativeFile = serverPath.substring(cfg.webpath.length);
							var rightPos = routerRelativeFile.lastIndexOf(".js");
							routerRelativeFile = routerRelativeFile.substring(0,rightPos);
							_this.printMessage('Adding ' + routerRelativeFile + " to router.json",'panel','info');
							allRouters[router_key][routerRelativeFile] ='.' + routerRelativeFile + ".js";
						});
						var routerJsonPath = _this.joinPath(webpath,router_key + "_router.json");
						fs.writeFileSync(routerJsonPath,JSON.stringify(allRouters[router_key]));
						_this.printMessage(router_key+ '_router.json generated.','panel','info');
					}
				}
				else{
					_this.printMessage('The config node "webpath" was not found in your server.json.')
				}
			}
			else{
				_this.printMessage('Config file issue.Please check it.','panel','info');
			}

		});
	},

	findModel(path,model_base_dir){
		var subs = fs.readdirSync(path);
		for(var item in subs){
			var nextPath = path + "\\" + subs[item];
			if(fs.lstatSync(nextPath).isDirectory()){
				if(!model_base_dir)
					model_base_dir = subs[item];
				if(path.indexOf(model_base_dir)<0)
					model_base_dir = subs[item];
				this.findModel(nextPath,model_base_dir);
			}
			else{
				if(this.isSelectedFile(nextPath,['.js'])){
					var fileContent = fs.readFileSync(nextPath);
					if(fileContent.indexOf("global.business.register(this,true);") >= 0){
						if(!(model_base_dir in this.modelFiles)){
							this.modelFiles[model_base_dir] = [];
						}
						this.modelFiles[model_base_dir].push(nextPath);
					}
				}
			}
		}
	},

	registerglobalmodel(action){
		this.opencfg((cfg,cfg_status,msg)=>{
			this.modelFiles = {};
			var _this = this;
			if(cfg_status){
				if("webpath" in cfg){
					var webpath = _this.joinPath(_this.rootDirPath,cfg.webpath);
					this.findModel(webpath,null);
					var allModels = {};
					for(var model_key in this.modelFiles){
						allModels[model_key] = {};
						this.modelFiles[model_key].forEach((e)=>{
							var serverPath = e.replace(this.rootDirPath,"").replace(/\\/g,'/');
							var modelRelativeFile = serverPath.substring(cfg.webpath.length);
							var rightPos = modelRelativeFile.lastIndexOf(".js");
							modelRelativeFile = modelRelativeFile.substring(0,rightPos);
							_this.printMessage('Adding ' + modelRelativeFile + " to globalmodel.json",'panel','info');
							allModels[model_key][modelRelativeFile] ='.' + modelRelativeFile + ".js";
						});
						var modelJsonPath = _this.joinPath(webpath,model_key + "_globalmodel.json");
						fs.writeFileSync(modelJsonPath,JSON.stringify(allModels[model_key]));
						_this.printMessage(model_key + '_globalmodel.json generated.','panel','info');
					}



				}
				else{
					_this.printMessage('The config node "webpath" was not found in your server.json.')
				}


			}
			else{
				_this.printMessage('Sorry!We can not handle multi-line selection.','panel','info');
			}

		});
	},

	folderIgnored(filepath,ignorefolders){
		if(filepath.charAt(filepath.length - 1) != "/"){
			filepath += "/";
		}
		for(var i=0;i<ignorefolders.length;i++){
			if(filepath.indexOf(ignorefolders[i])>=0){
				return true;
			}
		}
		return false;
	},

  get(action){
    this.opencfg((cfg,cfg_status,msg)=>{
      if(cfg_status){
				this.printMessage("Configure ok!Trying connect to [" + cfg.host + "] from port [" + cfg.port + "]...",'panel','info');
        this.connectServer(cfg,(sftp,conn_status,msg)=>{
          if(conn_status){
            //atom.workspace.getTextEditors()[1].getPath();
						this.sftp = sftp;
            this.touchedFiles.splice(0,this.touchedFiles.length);
              sftp.list(cfg.deploypath).then((data)=>{
								for(var i = 0;i<data.length;i++){
									var curfile = data[i];
						      curfile.name = this.joinPath(cfg.deploypath , curfile.name);
								}
                this.workerEmitter.emit('getAllFiles',0,sftp,data,0,(files)=>{
									var filesToDownload = [];
									for(var i=0;i<files.length;i++){
										var fone = files[i];
										if(fone.type != "d"){
											if("ignorefolders" in cfg){
												if(this.folderIgnored(fone.name,cfg.ignorefolders)){
													continue;
												}
											}
											if(cfg.usefilter){
												if(this.isSelectedFile(fone.name,cfg.filefilter)){
													filesToDownload.push(fone.name);
												}
											}
											else{
												filesToDownload.push(fone.name);
											}
										}
									}
									this.workerEmitter.emit('downloadFiles',sftp,filesToDownload,0,cfg.download_overwrite,(msg)=>{
										this.printMessage(msg,'panel','info');
									},(status,msg)=>{
										if(status){
											this.printMessage("Download finished." + filesToDownload.length + " files downloaded.",'panel','success');
											this.disconnectServer();
										}
										else{
											this.printMessage("Error happened while downloading files：" + msg,'panel','warning');
											this.disconnectServer();
										}

									})

                  //atom.notifications.addInfo(JSON.stringify(filesToDownload), {dismissable:true});
                });

              });
          }
          else{
						this.printMessage("Error happend while connecting to : [" + cfg.host + "]:" + msg,'panel','warning');

          }
        });
      }
      else{
				this.printMessage("Error happend while config:" + msg,'panel','warning');
      }
    });
  },

	uploadfolderToServer(){
		this.opencfg((cfg,cfg_status,msg)=>{
			if(cfg_status){
				this.localFiles = [];
				this.totalUploadedQty = 0;
				this.getLocalFiles(this.resolveTreeSelection(),cfg);
				this.connectServer(cfg,(sftp,conn_status,msg)=>{
          if(conn_status){
						this.sftp = sftp;
						this.printMessage("Configure ok!Trying connect to [" + cfg.host + "] from port [" + cfg.port + "]...",'panel','info');
						this.workerEmitter.emit('mkdirOnServer',sftp,this.localFiles,cfg.deploypath,0,(msg_running)=>{
							this.printMessage(msg_running,'panel','info');
						},(msg_finished)=>{
							this.printMessage("All folders have been pre-checked for upload.",'panel','info');
							this.workerEmitter.emit('uploadFilesToServer',sftp,this.localFiles,cfg.deploypath,0,(msg_running)=>{
								this.totalUploadedQty += 1;
								this.printMessage(msg_running,'panel','info');
							},(msg_finished)=>{
								this.printMessage('All files have been uploaded:Total ' + this.totalUploadedQty + ' files. ','panel','info');
								this.disconnectServer();
							});
						});
					}
					else{
						this.printMessage("Error happend while connecting to : [" + cfg.host + "]:" + msg,'panel','warning');
					}
				});

			}
			else{
				this.printMessage("Error happend while config:" + msg,'panel','warning');
			}

		});

	},

	cleansvr(action){
    this.opencfg((cfg,cfg_status,msg)=>{
      if(cfg_status){
				this.printMessage("Configure ok!Trying connect to [" + cfg.host + "] from port [" + cfg.port + "]...",'panel','info');
        this.connectServer(cfg,(sftp,conn_status,msg)=>{
          if(conn_status){
            //atom.workspace.getTextEditors()[1].getPath();
						this.sftp = sftp;
            this.touchedFiles.splice(0,this.touchedFiles.length);
              sftp.list(cfg.deploypath).then((data)=>{
								for(var i = 0;i<data.length;i++){
									var curfile = data[i];
						      curfile.name = this.joinPath(cfg.deploypath , curfile.name);
								}
                this.workerEmitter.emit('getAllFiles',0,sftp,data,0,(files)=>{
									var filesToClean = [];
									for(var i=0;i<files.length;i++){
										var fone = files[i];
										if(fone.type != "d"){
											if("ignorefolders" in cfg){
												if(this.folderIgnored(fone.name,cfg.ignorefolders)){
													continue;
												}
											}
											if(cfg.usefilter){
												if(this.isSelectedFile(fone.name,cfg.filefilter)){
													filesToClean.push(fone.name);
												}
											}
											else{
												filesToClean.push(fone.name);
											}
										}
									}
									this.workerEmitter.emit('cleanFiles',sftp,filesToClean,0,(msg)=>{
										this.printMessage(msg,'panel','info');
									},(status,msg)=>{
										if(status){
											this.printMessage("Clean finished." + filesToClean.length + " files cleaned.",'panel','success');
											this.disconnectServer();
										}
										else{
											this.printMessage("Error happened while cleaning files：" + msg,'panel','warning');
											this.disconnectServer();
										}

									})

                  //atom.notifications.addInfo(JSON.stringify(filesToDownload), {dismissable:true});
                });

              });
          }
          else{
						this.printMessage("Error happend while connecting to : [" + cfg.host + "]:" + msg,'panel','warning');

          }
        });
      }
      else{
				this.printMessage("Error happend while config:" + msg,'panel','warning');
      }
    });
  },
  deactivate() {
    this.modalPanel.destroy();
    this.subscriptions.dispose();
    this.deploytoserverView.destroy();
  },

  toggle() {
    console.log('Deploytoserver was toggled!');
    return (
      this.modalPanel.isVisible() ?
      this.modalPanel.hide() :
      this.modalPanel.show()
    );
  }

};
