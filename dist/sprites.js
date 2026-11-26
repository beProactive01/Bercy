function sprite(canvas,key){
  const ctx=canvas.getContext('2d');canvas.width=40;canvas.height=36;ctx.clearRect(0,0,40,36);
  const palettes={scout:['#96dfc5','#51ad99','#d8ffde'],writer:['#af91ef','#8765c7','#dbcdff'],mix:['#ffb385','#dc8468','#ffdab5'],check:['#f3d16a','#c7a344','#fff0a3']};
  const [main,shade,hi]=key==='lead'?['#91c4f9','#648eb8','#e1f3ff']:palettes[key],ink='#332d49';
  const rect=(x,y,w,h,c)=>{ctx.fillStyle=c;ctx.fillRect(x,y,w,h)};
  const shape=(pts,c)=>{for(const [y,x,w,h] of pts)rect(x,y,w,h,c)};
  // Pixel silhouettes use a shared grid, with distinct tools and body shapes for each role.
  if(key==='scout'){
    shape([[5,12,3,6],[3,10,3,4],[6,26,3,5],[4,28,3,4],[10,10,20,2],[12,7,26,3],[15,5,30,10],[25,8,24,3],[28,10,7,3],[28,24,7,3]],ink);
    shape([[12,11,18,2],[14,9,22,3],[17,7,26,7],[24,10,20,2],[26,12,3,3],[26,25,4,3]],main);
    rect(9,20,22,4,shade);rect(10,15,20,8,ink);rect(12,16,7,5,'#e6ffef');rect(21,16,7,5,'#e6ffef');rect(15,17,3,4,ink);rect(24,17,3,4,ink);rect(16,24,7,1,ink);rect(11,13,7,1,hi);
  }else if(key==='writer'){
    shape([[5,17,8,3],[8,12,17,3],[11,9,23,4],[15,7,27,11],[21,4,4,6],[19,32,5,5],[26,10,20,3],[29,9,6,2],[28,24,6,3]],ink);
    shape([[7,18,5,3],[10,14,13,3],[13,11,19,4],[17,9,23,8],[25,12,16,2],[22,5,3,3],[20,32,3,2]],main);
    rect(11,23,18,2,shade);rect(15,10,6,2,hi);rect(13,16,4,5,ink);rect(23,16,4,5,ink);rect(14,16,1,2,'white');rect(24,16,1,2,'white');rect(18,22,4,1,ink);rect(31,18,2,5,'#f4c666');rect(33,12,2,7,ink);rect(34,11,2,5,'#f4c666');
  }else if(key==='lead'){
    shape([[4,20,3,5],[8,15,12,3],[11,9,23,3],[14,6,28,10],[24,9,22,3],[27,10,7,3],[27,23,6,3]],ink); rect(11,13,18,3,main); rect(8,16,24,7,main);rect(11,23,18,2,shade);rect(11,17,18,5,ink);rect(13,18,4,2,hi);rect(23,18,4,2,hi);rect(18,25,5,1,ink);rect(21,4,2,2,'#efba64');
  }else if(key==='mix'){
    shape([[5,11,4,4],[7,15,3,3],[5,26,4,5],[9,10,21,3],[12,7,26,4],[16,5,30,9],[25,8,24,3],[28,10,6,3],[28,24,6,3]],ink);
    shape([[8,12,3,4],[8,26,2,4],[11,13,15,3],[14,9,22,10],[24,10,20,2]],main);
    rect(11,23,18,2,shade);rect(13,14,5,2,hi);rect(13,18,4,3,ink);rect(23,18,4,3,ink);rect(18,22,4,1,ink);rect(7,12,3,10,ink);rect(30,12,3,10,ink);rect(12,9,16,2,ink);rect(9,10,3,3,ink);rect(28,10,3,3,ink);rect(4,17,4,8,ink);rect(32,17,4,8,ink);rect(5,18,2,5,'#83739a');rect(33,18,2,5,'#83739a');
  }else{
    shape([[6,9,5,4],[6,26,5,4],[9,9,22,3],[12,7,26,12],[24,9,22,4],[28,11,6,3],[28,23,6,3]],ink);
    shape([[10,11,18,4],[14,9,22,9],[23,11,18,3]],main);rect(11,23,16,2,shade);rect(11,14,9,8,ink);rect(21,14,8,8,ink);rect(13,16,5,4,hi);rect(23,16,4,4,hi);rect(15,16,2,4,ink);rect(24,16,2,4,ink);rect(18,22,4,2,'#ba762d');
  }
}
