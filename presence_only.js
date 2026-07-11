'use strict';
// Presence-only: attach, NO Interceptor, NO .text patch. Just prove the agent is
// alive and read one byte. If ea.exbax fires from THIS, detection = agent/gum
// regions in maps (need kernel hide). If CRK survives, detection was the .text patch (CRC).
console.log('[+] presence-only agent alive');
var m = Process.findModuleByName('libgame.so');
console.log('[+] libgame.so @ ' + (m ? m.base : 'not yet'));
setInterval(function(){ console.log('[+] still alive ' + Date.now()); }, 3000);
