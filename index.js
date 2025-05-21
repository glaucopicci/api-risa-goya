<?php
/*
Plugin Name: Podio Webhook Filter
Description: Proxy Podio→Render: valida webhook via App-Auth e só repassa item.update com status “Revisar”.
Version: 2.7
Author: Goya Conteúdo
*/

if ( ! defined( 'ABSPATH' ) ) exit;

// CONFIGURAÇÃO
define( 'PODIO_APP_ID',              '25797246' );
define( 'PODIO_APP_TOKEN',           'd72b05c0f30432e975dba1de0ef2d28c' );
define( 'PODIO_CLIENT_ID',           'goya-risa' );
define( 'PODIO_CLIENT_SECRET',       'dTldSyr5APBGs7uLB84JduAHjgJ0Q7K73QlVPPgwGUV4Rvosj1zScmXf6brVCqh5' );
define( 'PODIO_WEBHOOK_ID',          '23925520' );
define( 'PODIO_STATUS_FIELD_ID',     '220199999' );
define( 'PODIO_STATUS_REVISAR_OPTION_ID', '4' );
define( 'WEBHOOK_URL',               'https://risa-webhook-novo.onrender.com/webhook' );

// flush rules
register_activation_hook(__FILE__,'pwf_flush'); register_deactivation_hook(__FILE__,'pwf_flush');
function pwf_flush(){ flush_rewrite_rules(); }

// registra rota
add_action('rest_api_init', function(){
  register_rest_route('podio/v1','/hook',[
    'methods'=>WP_REST_Server::CREATABLE,
    'callback'=>'pwf_handle',
    'permission_callback'=>'__return_true',
  ]);
});

function pwf_handle(WP_REST_Request $req){
  error_log('[Podio v2.7] BODY_RAW: '.$req->get_body());

  parse_str($req->get_body(), $body);
  $type    = $body['type']    ?? '';
  $hook_id = (string)($body['hook_id'] ?? '');
  $code    = $body['code']    ?? '';

  // 1) handshake real
  if($type==='hook.verify' && $hook_id===PODIO_WEBHOOK_ID && $code){
    // App-Auth form-urlencoded
    $oauth = wp_remote_post('https://podio.com/oauth/token',[
      'body'=>[
        'grant_type'=>'app',
        'app_id'=>PODIO_APP_ID,
        'app_token'=>PODIO_APP_TOKEN,
        'client_id'=>PODIO_CLIENT_ID,
        'client_secret'=>PODIO_CLIENT_SECRET,
      ],
      'timeout'=>10,
    ]);
    if(is_wp_error($oauth)){
      error_log('[Podio v2.7] OAuth Error: '.$oauth->get_error_message());
      return new WP_Error('podio_oauth_error','Erro ao autenticar',['status'=>500]);
    }
    $data = json_decode(wp_remote_retrieve_body($oauth), true);
    if(empty($data['access_token'])){
      error_log('[Podio v2.7] Sem access_token: '.print_r($data,true));
      return new WP_Error('podio_oauth_no_token','Token não retornado',['status'=>500]);
    }
    // valida no Podio
    $val = wp_remote_post(
      sprintf('https://api.podio.com/hook/%s/verify/validate',$hook_id),
      [
        'headers'=>[
          'Authorization'=>'Bearer '.$data['access_token'],
          'Content-Type'=>'application/json',
        ],
        'body'=>wp_json_encode(['code'=>$code]),
        'timeout'=>10,
      ]
    );
    $status = wp_remote_retrieve_response_code($val);
    error_log("[Podio v2.7] verify/validate status: {$status}");
    if($status>=200 && $status<300){
      // retorna 204 No Content para o Podio completar o webhook
      return rest_ensure_response(null, 204);
    }
    return new WP_Error('podio_verify_failed',"Falha na validação (HTTP {$status})",['status'=>$status]);
  }

  // 2) ignora outros hooks
  if($hook_id!==PODIO_WEBHOOK_ID){
    return rest_ensure_response('Ignored');
  }

  // 3) filtra item.update → Revisar
  if($type==='item.update'){
    $payload = json_decode($req->get_body(), true);
    $diffs   = $payload['data']['revision']['diffs'] ?? [];
    foreach($diffs as $d){
      if((string)$d['field_id']===PODIO_STATUS_FIELD_ID
        && (string)$d['new_value']===PODIO_STATUS_REVISAR_OPTION_ID
        && (string)$d['original_value']!==PODIO_STATUS_REVISAR_OPTION_ID
      ){
        wp_remote_post(WEBHOOK_URL,[
          'headers'=>['Content-Type'=>'application/json'],
          'body'=>wp_json_encode($payload),
          'timeout'=>5,
        ]);
        break;
      }
    }
  }

  return rest_ensure_response('OK');
}
