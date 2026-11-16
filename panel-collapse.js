document.querySelectorAll('[data-minimize-target]').forEach(button=>{
  const target=document.getElementById(button.dataset.minimizeTarget);
  if(!target)return;
  button.addEventListener('click',()=>{
    const collapsed=!target.hidden;
    target.hidden=collapsed;
    button.textContent=collapsed?'Restore':'Minimize';
    button.setAttribute('aria-expanded',String(!collapsed));
  });
});
